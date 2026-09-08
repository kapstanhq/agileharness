---
id: story-busca-por-titulo
type: story
title: Buscar pelo título
storyType: user
status: enriquecer
parent: step-buscar
release: r1
personas:
- leitor
systems:
- catalogo
links: []
narrative:
  role: leitora que compra livros na loja
  want: buscar pelo título
  soThat: chego ao livro certo sem navegar por menus
acceptance:
- Dado que estou na loja, quando buscar pelo título, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando buscar pelo título, então vejo o motivo e o que fazer a seguir.
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
