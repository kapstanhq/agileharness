---
id: story-estoque-alerta
type: story
title: Ser avisado de estoque baixo
storyType: user
status: concluida
parent: step-estoque
release: r2
personas:
  - leitor
systems:
  - catalogo
links: []
narrative:
  role: leitora que compra livros na loja
  want: ser avisado de estoque baixo
  soThat: não vendo o que não tenho
acceptance:
  - >-
    Dado que estou na loja, quando ser avisado de estoque baixo, então a loja
    confirma a ação na própria tela.
  - >-
    Dado que a operação falha, quando ser avisado de estoque baixo, então vejo o
    motivo e o que fazer a seguir.
tasks: []
rice:
  reach: null
  impact: null
  confidence: null
  effort: null
kano: null
funnelStage: null
questions:
  - id: q1
    text: Vale cobrir o caso offline nesta fatia?
    status: answered
    answer: (sem resposta — card concluído/arquivado)
    answeredAt: '2026-08-06'
findings:
  - id: f1
    lens: general
    severity: medium
    title: O estado vazio não explica o que fazer a seguir
    status: open
order: 20
created: '2026-08-01'
updated: '2026-08-06'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
