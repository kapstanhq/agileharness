---
id: story-vitrine-curadoria
type: story
title: Ver a curadoria da livreira
storyType: user
status: com-design
parent: step-vitrine
release: r2
personas:
- colecionador
systems:
- catalogo
links: []
narrative:
  role: colecionador de edições especiais
  want: ver a curadoria da livreira
  soThat: descubro novidades sem saber de antemão o que procurar
acceptance:
- Dado que estou na loja, quando ver a curadoria da livreira, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando ver a curadoria da livreira, então vejo o motivo e o que fazer a seguir.
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
