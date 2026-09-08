---
id: story-cupom-marcador
type: story
title: Escolher um marcador de brinde
storyType: user
status: ready
parent: step-cupom
release: r1
personas:
- livreiro
systems:
- checkout
links: []
narrative:
  role: livreiro que opera a loja
  want: escolher um marcador de brinde
  soThat: uso os descontos a que tenho direito
acceptance:
- Dado que estou na loja, quando escolher um marcador de brinde, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando escolher um marcador de brinde, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
