---
id: story-preferencias-excluir
type: story
title: Excluir a minha conta e os meus dados
storyType: user
status: qa-automatizado
parent: step-preferencias
release: r1
personas:
- colecionador
systems:
- catalogo
links: []
narrative:
  role: colecionador de edições especiais
  want: excluir a minha conta e os meus dados
  soThat: a loja fala comigo do jeito que eu quero
acceptance:
- Dado que estou na loja, quando excluir a minha conta e os meus dados, então a loja confirma a ação na
  própria tela.
- Dado que a operação falha, quando excluir a minha conta e os meus dados, então vejo o motivo e o que
  fazer a seguir.
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
