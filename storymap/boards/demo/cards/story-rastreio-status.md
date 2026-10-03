---
id: story-rastreio-status
type: story
title: Acompanhar o status do pedido
storyType: user
status: qa-automatizado
parent: step-rastreio
release: r1
personas:
- colecionador
systems:
- catalogo
links: []
narrative:
  role: colecionador de edições especiais
  want: acompanhar o status do pedido
  soThat: sei onde está o meu pedido sem precisar perguntar
acceptance:
- Dado que estou na loja, quando acompanhar o status do pedido, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando acompanhar o status do pedido, então vejo o motivo e o que fazer a
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
order: 10
created: '2026-08-01'
updated: '2026-08-01'
findings:
- id: f1
  lens: ux
  severity: minor
  status: open
  title: O estado vazio não explica o que fazer a seguir
questions:
- id: q1
  text: Vale cobrir o caso offline nesta fatia?
  status: open
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
