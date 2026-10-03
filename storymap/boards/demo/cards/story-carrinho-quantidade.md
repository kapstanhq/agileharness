---
id: story-carrinho-quantidade
type: story
title: Ajustar a quantidade de um item
storyType: user
status: triage
parent: step-carrinho
release: r2
personas:
- leitor
systems:
- busca
links: []
narrative:
  role: leitora que compra livros na loja
  want: ajustar a quantidade de um item
  soThat: junto o que quero e reviso antes de pagar
acceptance:
- Dado que estou na loja, quando ajustar a quantidade de um item, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando ajustar a quantidade de um item, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
