---
id: story-devolucao-estorno
type: story
title: Acompanhar o estorno
storyType: user
status: concluida
parent: step-devolucao
release: r2
personas:
  - livreiro
systems:
  - catalogo
links: []
narrative:
  role: livreiro que opera a loja
  want: acompanhar o estorno
  soThat: resolvo um problema sem depender de telefone
acceptance:
  - >-
    Dado que estou na loja, quando acompanhar o estorno, então a loja confirma a
    ação na própria tela.
  - >-
    Dado que a operação falha, quando acompanhar o estorno, então vejo o motivo
    e o que fazer a seguir.
tasks: []
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
order: 30
created: '2026-08-01'
updated: '2026-08-06'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
