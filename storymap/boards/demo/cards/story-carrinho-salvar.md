---
id: story-carrinho-salvar
type: story
title: Salvar o carrinho para depois
storyType: user
status: enriquecer
parent: step-carrinho
release: r1
personas:
- leitor
systems:
- catalogo
links: []
narrative:
  role: leitora que compra livros na loja
  want: salvar o carrinho para depois
  soThat: junto o que quero e reviso antes de pagar
acceptance:
- Dado que estou na loja, quando salvar o carrinho para depois, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando salvar o carrinho para depois, então vejo o motivo e o que fazer a
  seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
findings:
- id: f1
  lens: ux
  severity: minor
  status: open
  title: O estado vazio não explica o que fazer a seguir
questions:
- id: q1
  text: Vale cobrir o caso offline nesta fatia?
  status: open
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
