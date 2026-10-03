// PARA ONDE VOLTAR depois do login — o saneamento do `?next=`, em UM lugar só.
//
// O portão manda `/login?next=<path>` para o operador cair de volta onde estava. Esse valor vem
// da URL, ou seja, de QUALQUER pessoa que consiga fazer o operador clicar num link — e é assim
// que uma tela de login vira ferramenta de phishing: `?next=https://sitedoatacante` e o operador,
// que acabou de digitar o token com sucesso, é despejado num clone da tela pedindo "de novo".
//
// Por isso o servidor (app/login/page.tsx) e o cliente (components/auth/LoginForm.tsx) chamam
// ESTA função, e não cada um a sua regra: duas cópias divergem, e a que apodrece é a que abre.

/**
 * Byte que não existe num path legítimo: controle C0, espaço cru (viaja como %20) e DEL — todos
 * matéria-prima de header splitting.
 *
 * Escrito como comparação de CODE POINT, não como regex com escapes: uma classe de caracteres
 * escrita com `\u0000` vira BYTE LITERAL no arquivo dependendo de quem o escreve, e um NUL literal
 * no fonte é invisível na revisão, quebra `grep` e já quebrou o split do merge train neste repo.
 */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Devolve o destino se ele for um caminho interno seguro, senão `null` (o chamador manda para `/`).
 *
 * A regra é uma allowlist de FORMA, não uma blocklist de destinos ruins:
 * começa com UMA barra, e nada de barra dupla, barra invertida, controle ou espaço.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  if (!raw.startsWith("/")) return null;

  // `//evil.example` é uma URL protocol-relative: o navegador completa o esquema e SAI do site.
  if (raw.startsWith("//")) return null;

  // A BARRA INVERTIDA é o furo que a checagem óbvia (`startsWith("/") && !startsWith("//")`)
  // deixa passar — e é exatamente o que a primeira versão desta tela deixou passar: `/\evil.example`
  // satisfaz as duas condições, mas o parser de URL do WHATWG trata `\` como `/`, então o navegador
  // lê `//evil.example` e navega para FORA. Recusar toda barra invertida mata a família inteira
  // (`/\`, `/\/`, `/\\`) sem precisar adivinhar a normalização de cada navegador.
  if (raw.includes("\\")) return null;

  if (hasForbiddenChar(raw)) return null;

  return raw;
}
