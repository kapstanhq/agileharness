---
id: story-cupom-primeira-compra
type: story
title: Ganhar desconto na primeira compra
storyType: user
status: com-design
parent: step-cupom
release: r2
personas:
- livreiro
systems:
- catalogo
links:
- rel: relates-to
  to: story-cadastro-criar
narrative:
  role: livreiro que opera a loja
  want: ganhar desconto na primeira compra
  soThat: uso os descontos a que tenho direito
acceptance:
- Dado que estou na loja, quando ganhar desconto na primeira compra, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando ganhar desconto na primeira compra, então vejo o motivo e o que fazer
  a seguir.
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
