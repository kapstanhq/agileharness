---
id: story-lista-compartilhar
type: story
title: Compartilhar a lista por link
storyType: user
status: pronta
parent: step-lista
release: r1
personas:
- livreiro
systems:
- entrega
links: []
narrative:
  role: livreiro que opera a loja
  want: compartilhar a lista por link
  soThat: compartilho o que ando lendo
acceptance:
- Dado que estou na loja, quando compartilhar a lista por link, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando compartilhar a lista por link, então vejo o motivo e o que fazer a
  seguir.
tasks:
- id: t1
  title: Desenhar a tela e o estado vazio
  done: true
- id: t2
  title: Ligar a tela ao serviço
  done: true
- id: t3
  title: Cobrir com teste de aceite
  done: false
order: 20
created: '2026-08-01'
updated: '2026-08-01'
priorityCall:
  rank: 2
  rationale: Estimado contra as âncoras já pontuadas do board.
  source: reasoning
  assessedAt: '2026-08-01'
  wsjf:
    value: 1
    urgency: 3
    unlock: 8
    size: 2
    basis:
    - soThat
    - aceite
    - personas
    cohortSize: 66
    cohortAt: '2026-08-01T12:00:00.000Z'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
