---
id: story-endereco-cadastrar
type: story
title: Cadastrar um endereço de entrega
storyType: user
status: ready
parent: step-enderecos
release: r1
personas:
- leitor
systems:
- checkout
links: []
narrative:
  role: leitora que compra livros na loja
  want: cadastrar um endereço de entrega
  soThat: compro sem redigitar o endereço toda vez
acceptance:
- Dado que estou na loja, quando cadastrar um endereço de entrega, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando cadastrar um endereço de entrega, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 10
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
