---
id: story-reembolso-parcial
type: story
title: Fazer um reembolso parcial
storyType: user
status: com-design
parent: step-reembolso
release: r2
personas:
- leitor
systems:
- catalogo
links: []
narrative:
  role: leitora que compra livros na loja
  want: fazer um reembolso parcial
  soThat: o dinheiro volta sem eu ter de cobrar
acceptance:
- Dado que estou na loja, quando fazer um reembolso parcial, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando fazer um reembolso parcial, então vejo o motivo e o que fazer a seguir.
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
