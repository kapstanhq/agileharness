---
id: story-ficha-disponibilidade
type: story
title: Saber se o título está em estoque
storyType: user
status: revisao
parent: step-ficha
release: r2
personas:
- leitor
systems:
- checkout
links: []
narrative:
  role: leitora que compra livros na loja
  want: saber se o título está em estoque
  soThat: decido pela sinopse, pela edição e pelo número de páginas
acceptance:
- Dado que estou na loja, quando saber se o título está em estoque, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando saber se o título está em estoque, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
