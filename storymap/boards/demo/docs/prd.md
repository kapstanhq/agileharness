---
doc: prd
format: 2
---

# PRD

## Problema

### Descoberta

- Quem lê muito não descobre o próximo livro — descobre o mais vendido. A vitrine grande otimiza para o que já vende, e quem lê 12 livros por ano já leu esses.
- A indicação boa vem de gente, e não escala além do balcão: o livreiro atende um cliente por vez, e só quem entra na loja.

### Risco da compra

- Devolver um livro que não era o esperado custa mais caro que o livro — então o leitor deixa de arriscar, e volta a comprar o óbvio.

## Personas

### Leitor frequente (early adopter)

- **Job-to-be-done** — achar o próximo livro sem virar a lista de mais vendidos, e sem pedir indicação para o grupo de WhatsApp.
- **Quando decide** — ao terminar um livro. A janela é curta: se não achar o próximo em dias, compra o mais vendido ou não compra.
- **O que o faz desistir** — recomendação genérica. Ele reconhece «quem comprou também comprou» de longe, e isso queima a confiança na vitrine inteira.

### Quem presenteia

- **Job-to-be-done** — acertar um livro para outra pessoa sem conhecer o gosto dela em detalhe.
- **O que o faz desistir** — medo de errar. Por isso a devolução fácil é parte do produto, e não uma política no rodapé.

### Colecionador de edições especiais

- **Job-to-be-done** — saber da tiragem pequena ANTES de ela esgotar. Compra por escassez, não por recomendação.

## Proposta de valor

Para leitores que compram por indicação e não por catálogo, a Aurora é a livraria que conhece o seu gosto — ao contrário dos marketplaces, que conhecem o seu histórico de compra.

A Aurora é uma livraria de bairro com sete anos de fichas de gosto escritas à mão no balcão. Este PRD descreve o produto que leva essa curadoria para fora da loja: uma vitrine online que recomenda pelo **gosto declarado** do leitor, e não pelo histórico de compra dele.

**Por que agora:** as fichas foram digitalizadas este ano, e os 300 clientes que já as têm são um público que sabemos servir e que hoje compra no marketplace por falta de alternativa online.

> Board de demonstração. Os dados são fictícios e existem para que as telas do AgileHarness tenham o que mostrar a quem acabou de instalar.

## Funcionalidades

### Nesta versão

- Ficha de gosto online — o leitor declara o que gosta em vez de o sistema inferir do que ele comprou.
- Vitrine de recomendação da casa, com o PORQUÊ visível em cada indicação («porque você marcou X»).
- Trecho do audiolivro antes de comprar.
- Devolução em um clique nos primeiros 7 dias.

## Fluxo de uso

- **Declarar o gosto** — o leitor chega pela newsletter ou pela loja física → preenche a ficha (autores, temas, o que NÃO quer) → vê a primeira vitrine já personalizada.
- **Descobrir o próximo livro** — abre a vitrine → lê o porquê de cada indicação → ouve o trecho → compra.
- **Errar sem custo** — recebe → não era → devolve em um clique dentro de 7 dias → a devolução REALIMENTA a ficha de gosto (é o que a torna barata para a loja).
- **Presentear** — responde três perguntas sobre a outra pessoa → recebe três opções com o porquê → envia com a devolução já incluída.
- **Curar (o lado da casa)** — o livreiro vê o que a curadoria automatiza recomendou → corrige o que está errado → a correção vale para os próximos leitores de gosto parecido.

## Métricas de sucesso

- A aposta: se a recomendação da casa for boa o bastante, o leitor volta a comprar **na Aurora** o que hoje compra no marketplace — e a curadoria, que hoje é um custo do balcão, vira o motivo de a loja existir online.
- O resultado-alvo mede a fração de pedidos que nascem de uma recomendação nossa, porque é isso que separa «temos uma loja online» de «temos a nossa loja online».
- Métrica de negócio: Valor de vida do cliente (CLV) em 24 meses
- Resultado-alvo: Dobrar a fração de pedidos que nascem de uma recomendação da casa (hoje 11%) até o fim do r2.

## Fora do escopo

- Clube de assinatura mensal — depende de a recomendação já estar boa; vender assinatura antes disso queima o cliente.
- Pré-venda de edições especiais (serve o colecionador, que é o terceiro público).
- App nativo. A vitrine é web e responsiva.
- Nunca: Recomendar por «quem comprou também comprou». É exatamente a alternativa da qual o cliente está fugindo — fazer isso apaga a razão de existir.
- Nunca: Vender o dado de gosto do leitor, ou usá-lo fora da recomendação da casa.
