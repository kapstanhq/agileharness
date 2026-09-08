---
id: story-resenha-util
type: story
title: Marcar uma resenha como útil
storyType: user
status: enriquecer
parent: step-resenha
release: r1
personas:
- colecionador
systems:
- catalogo
links:
- rel: relates-to
  to: story-resenha-escrever
narrative:
  role: colecionador de edições especiais
  want: marcar uma resenha como útil
  soThat: conto para outros leitores o que achei
acceptance:
- Dado que estou na loja, quando marcar uma resenha como útil, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando marcar uma resenha como útil, então vejo o motivo e o que fazer a
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
