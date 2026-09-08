---
doc: prd
---

# PRD

## Resumo executivo

A Aurora é uma livraria de bairro com sete anos de fichas de gosto escritas à mão no balcão. Este PRD descreve o produto que leva essa curadoria para fora da loja: uma vitrine online que recomenda pelo **gosto declarado** do leitor, e não pelo histórico de compra dele.

**Por que agora:** as fichas foram digitalizadas este ano, e os 300 clientes que já as têm são um público que sabemos servir e que hoje compra no marketplace por falta de alternativa online.

> Board de demonstração. Os dados são fictícios e existem para que as telas do AgileHarness tenham o que mostrar a quem acabou de instalar.

## Problema

### Descoberta

- Quem lê muito não descobre o próximo livro — descobre o mais vendido. A vitrine grande otimiza para o que já vende, e quem lê 12 livros por ano já leu esses.
- A indicação boa vem de gente, e não escala além do balcão: o livreiro atende um cliente por vez, e só quem entra na loja.

### Risco da compra

- Devolver um livro que não era o esperado custa mais caro que o livro — então o leitor deixa de arriscar, e volta a comprar o óbvio.

## Público

### Leitor frequente (early adopter)

- **Job-to-be-done** — achar o próximo livro sem virar a lista de mais vendidos, e sem pedir indicação para o grupo de WhatsApp.
- **Quando decide** — ao terminar um livro. A janela é curta: se não achar o próximo em dias, compra o mais vendido ou não compra.
- **O que o faz desistir** — recomendação genérica. Ele reconhece «quem comprou também comprou» de longe, e isso queima a confiança na vitrine inteira.

### Quem presenteia

- **Job-to-be-done** — acertar um livro para outra pessoa sem conhecer o gosto dela em detalhe.
- **O que o faz desistir** — medo de errar. Por isso a devolução fácil é parte do produto, e não uma política no rodapé.

### Colecionador de edições especiais

- **Job-to-be-done** — saber da tiragem pequena ANTES de ela esgotar. Compra por escassez, não por recomendação.

## Posicionamento

Para leitores que compram por indicação e não por catálogo, a Aurora é a livraria que conhece o seu gosto — ao contrário dos marketplaces, que conhecem o seu histórico de compra.

## Objetivos e métricas

A aposta: se a recomendação da casa for boa o bastante, o leitor volta a comprar **na Aurora** o que hoje compra no marketplace — e a curadoria, que hoje é um custo do balcão, vira o motivo de a loja existir online.

O resultado-alvo mede a fração de pedidos que nascem de uma recomendação nossa, porque é isso que separa «temos uma loja online» de «temos a nossa loja online».

### Métrica de negócio

- Valor de vida do cliente (CLV) em 24 meses

### Resultado-alvo

- Dobrar a fração de pedidos que nascem de uma recomendação da casa (hoje 11%) até o fim do r2.

## Escopo

### Nesta versão

- Ficha de gosto online — o leitor declara o que gosta em vez de o sistema inferir do que ele comprou.
- Vitrine de recomendação da casa, com o PORQUÊ visível em cada indicação («porque você marcou X»).
- Trecho do audiolivro antes de comprar.
- Devolução em um clique nos primeiros 7 dias.

### Fora, por ora

- Clube de assinatura mensal — depende de a recomendação já estar boa; vender assinatura antes disso queima o cliente.
- Pré-venda de edições especiais (serve o colecionador, que é o terceiro público).
- App nativo. A vitrine é web e responsiva.

### Nunca

- Recomendar por «quem comprou também comprou». É exatamente a alternativa da qual o cliente está fugindo — fazer isso apaga a razão de existir.
- Vender o dado de gosto do leitor, ou usá-lo fora da recomendação da casa.

## Jornadas

- **Declarar o gosto** — o leitor chega pela newsletter ou pela loja física → preenche a ficha (autores, temas, o que NÃO quer) → vê a primeira vitrine já personalizada.
- **Descobrir o próximo livro** — abre a vitrine → lê o porquê de cada indicação → ouve o trecho → compra.
- **Errar sem custo** — recebe → não era → devolve em um clique dentro de 7 dias → a devolução REALIMENTA a ficha de gosto (é o que a torna barata para a loja).
- **Presentear** — responde três perguntas sobre a outra pessoa → recebe três opções com o porquê → envia com a devolução já incluída.
- **Curar (o lado da casa)** — o livreiro vê o que a curadoria automatiza recomendou → corrige o que está errado → a correção vale para os próximos leitores de gosto parecido.

## Decisões já tomadas

- **Recomendação por gosto DECLARADO, nunca por histórico de compra.** Não é preferiência técnica: é o posicionamento. Quem implementar «quem comprou também comprou» apagou o produto.
- **Toda recomendação mostra o PORQUÊ.** Uma indicação sem justificativa é indistinguível da do marketplace, e é assim que a confiança se perde.
- **A devolução de 7 dias é parte do produto, não política.** Ela aparece ANTES da compra, e o frete dela já está no custo.
- **A ficha de gosto é do leitor.** Ele vê, edita e apaga. Nada dela sai da recomendação da casa.
- **As 40 editoras pequenas têm prioridade na vitrine** quando empatam com um título de editora grande — é a vantagem que o marketplace não consegue copiar.

## Riscos e perguntas em aberto

- [ ] **A premissa que cancela o resto:** a ficha de gosto declarada recomenda melhor que o histórico de compra? Teste mais barato: 20 fichas contra o algoritmo do marketplace, com os 300 clientes da loja física.
- [ ] **A devolução fácil pode custar mais do que traz.** O frete dos 7 dias está no custo, mas a taxa de devolução real é chute até a primeira safra.
- [ ] **Pergunta em aberto:** quantas fichas são necessárias antes de a curadoria automática ficar melhor que o livreiro? Abaixo desse número, a vitrine decepciona justamente o early adopter.
- [ ] **Pergunta em aberto:** as 40 editoras pequenas conseguem atender o volume se a vitrine funcionar?

## Pronto quando

- Um leitor com ficha preenchida abre a vitrine e reconhece pelo menos um título que não teria achado sozinho. Observável: teste com 10 dos 300 clientes da loja física.
- Toda indicação na vitrine carrega o porquê, e o porquê cita algo que o leitor declarou. Observável na própria tela, sem abrir o banco.
- A devolução em 7 dias fecha em um clique e a ficha de gosto muda depois dela. Observável: devolver e ver a próxima vitrine diferente.
- Nenhuma tela sugere título por «quem comprou também comprou». Observável: revisão da vitrine inteira antes de publicar.
