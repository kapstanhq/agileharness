---
id: story-rastreio-notificacao
type: story
title: Receber aviso de saiu para entrega
storyType: user
status: revisao
parent: step-rastreio
release: r2
personas:
- colecionador
systems:
- checkout
links: []
narrative:
  role: colecionador de edições especiais
  want: receber aviso de saiu para entrega
  soThat: sei onde está o meu pedido sem precisar perguntar
acceptance:
- Dado que estou na loja, quando receber aviso de saiu para entrega, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando receber aviso de saiu para entrega, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
