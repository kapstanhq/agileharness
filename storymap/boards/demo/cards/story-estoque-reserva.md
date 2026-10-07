---
id: story-estoque-reserva
type: story
title: Reservar exemplares de uma pré-venda
storyType: user
status: concluida
parent: step-estoque
release: r1
personas:
- leitor
systems:
- checkout
links: []
narrative:
  role: leitora que compra livros na loja
  want: reservar exemplares de uma pré-venda
  soThat: não vendo o que não tenho
acceptance:
- Dado que estou na loja, quando reservar exemplares de uma pré-venda, então a loja confirma a ação na
  própria tela.
- Dado que a operação falha, quando reservar exemplares de uma pré-venda, então vejo o motivo e o que
  fazer a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
