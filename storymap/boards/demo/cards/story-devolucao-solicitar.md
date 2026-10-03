---
id: story-devolucao-solicitar
type: story
title: Solicitar a devolução de um item
storyType: user
status: stage
parent: step-devolucao
release: r2
personas:
- livreiro
systems:
- contas
links: []
narrative:
  role: livreiro que opera a loja
  want: solicitar a devolução de um item
  soThat: resolvo um problema sem depender de telefone
acceptance:
- Dado que estou na loja, quando solicitar a devolução de um item, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando solicitar a devolução de um item, então vejo o motivo e o que fazer
  a seguir.
tasks:
- id: t1
  title: Desenhar a tela e o estado vazio
  done: true
- id: t2
  title: Ligar a tela ao serviço
  done: false
- id: t3
  title: Cobrir com teste de aceite
  done: false
order: 10
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
