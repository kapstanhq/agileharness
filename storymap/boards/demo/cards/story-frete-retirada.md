---
id: story-frete-retirada
type: story
title: Retirar na loja física
storyType: user
status: desenvolver
parent: step-frete
release: r1
personas:
- leitor
systems:
- contas
links: []
narrative:
  role: leitora que compra livros na loja
  want: retirar na loja física
  soThat: escolho entre preço e prazo com a informação na mão
acceptance:
- Dado que estou na loja, quando retirar na loja física, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando retirar na loja física, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
priorityCall:
  rank: 0
  rationale: Estimado contra as âncoras já pontuadas do board.
  source: reasoning
  assessedAt: '2026-08-01'
  wsjf:
    value: 8
    urgency: 1
    unlock: 3
    size: 13
    basis:
    - soThat
    - aceite
    - personas
    cohortSize: 66
    cohortAt: '2026-08-01T12:00:00.000Z'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
