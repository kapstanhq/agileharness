---
id: story-comparar-formatos
type: story
title: Comparar o preço por formato
storyType: user
status: concluida
parent: step-comparar
release: r2
personas:
  - livreiro
systems:
  - catalogo
links: []
narrative:
  role: livreiro que opera a loja
  want: comparar o preço por formato
  soThat: escolho entre edições e formatos sabendo o custo total
acceptance:
  - >-
    Dado que estou na loja, quando comparar o preço por formato, então a loja
    confirma a ação na própria tela.
  - >-
    Dado que a operação falha, quando comparar o preço por formato, então vejo o
    motivo e o que fazer a seguir.
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
order: 10
created: '2026-08-01'
updated: '2026-08-06'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
