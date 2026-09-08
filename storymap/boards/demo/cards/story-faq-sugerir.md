---
id: story-faq-sugerir
type: story
title: Receber um artigo sugerido ao abrir o chamado
storyType: user
status: design-ux
parent: step-faq
release: r2
personas:
- leitor
systems:
- contas
links: []
narrative:
  role: leitora que compra livros na loja
  want: receber um artigo sugerido ao abrir o chamado
  soThat: resolvo sozinho o que já tem resposta
acceptance:
- Dado que estou na loja, quando receber um artigo sugerido ao abrir o chamado, então a loja confirma
  a ação na própria tela.
- Dado que a operação falha, quando receber um artigo sugerido ao abrir o chamado, então vejo o motivo
  e o que fazer a seguir.
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
order: 20
created: '2026-08-01'
updated: '2026-08-01'
priorityCall:
  rank: 1
  rationale: Estimado contra as âncoras já pontuadas do board.
  source: reasoning
  assessedAt: '2026-08-01'
  wsjf:
    value: 5
    urgency: 13
    unlock: 2
    size: 8
    basis:
    - soThat
    - aceite
    - personas
    cohortSize: 66
    cohortAt: '2026-08-01T12:00:00.000Z'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
