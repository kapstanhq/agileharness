---
id: story-ficha-edicoes
type: story
title: Ver as edições disponíveis
storyType: user
status: qa-automatizado
parent: step-ficha
release: r1
personas:
- leitor
systems:
- catalogo
links: []
narrative:
  role: leitora que compra livros na loja
  want: ver as edições disponíveis
  soThat: decido pela sinopse, pela edição e pelo número de páginas
acceptance:
- Dado que estou na loja, quando ver as edições disponíveis, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando ver as edições disponíveis, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 20
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
