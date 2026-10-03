---
id: story-amostra-download
type: story
title: Baixar a amostra em epub
storyType: user
status: release
parent: step-amostra
release: r1
personas:
- colecionador
systems:
- busca
links: []
narrative:
  role: colecionador de edições especiais
  want: baixar a amostra em epub
  soThat: experimento o texto antes de comprar
acceptance:
- Dado que estou na loja, quando baixar a amostra em epub, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando baixar a amostra em epub, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
priorityCall:
  rank: 1
  rationale: Estimado contra as âncoras já pontuadas do board.
  source: reasoning
  assessedAt: '2026-08-01'
  wsjf:
    value: 3
    urgency: 8
    unlock: 1
    size: 5
    basis:
    - soThat
    - aceite
    - personas
    cohortSize: 66
    cohortAt: '2026-08-01T12:00:00.000Z'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
