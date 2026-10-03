---
id: story-preferencias-email
type: story
title: Escolher que e-mails quero receber
storyType: user
status: revisar-codigo
parent: step-preferencias
release: r2
personas:
- colecionador
systems:
- busca
links: []
narrative:
  role: colecionador de edições especiais
  want: escolher que e-mails quero receber
  soThat: a loja fala comigo do jeito que eu quero
acceptance:
- Dado que estou na loja, quando escolher que e-mails quero receber, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando escolher que e-mails quero receber, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
priorityCall:
  rank: 2
  rationale: Estimado contra as âncoras já pontuadas do board.
  source: reasoning
  assessedAt: '2026-08-01'
  wsjf:
    value: 2
    urgency: 5
    unlock: 13
    size: 3
    basis:
    - soThat
    - aceite
    - personas
    cohortSize: 66
    cohortAt: '2026-08-01T12:00:00.000Z'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
