---
id: story-rastreio-atraso
type: story
title: Ser avisado quando houver atraso
storyType: user
status: merge
parent: step-rastreio
release: r1
personas:
- colecionador
systems:
- entrega
links:
- rel: depends-on
  to: story-rastreio-status
narrative:
  role: colecionador de edições especiais
  want: ser avisado quando houver atraso
  soThat: sei onde está o meu pedido sem precisar perguntar
acceptance:
- Dado que estou na loja, quando ser avisado quando houver atraso, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando ser avisado quando houver atraso, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
