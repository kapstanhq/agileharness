---
id: story-resenha-moderar
type: story
title: Ter a resenha moderada antes de publicar
storyType: user
status: triage
parent: step-resenha
release: r2
personas:
- colecionador
systems:
- busca
links: []
narrative:
  role: colecionador de edições especiais
  want: ter a resenha moderada antes de publicar
  soThat: conto para outros leitores o que achei
acceptance:
- Dado que estou na loja, quando ter a resenha moderada antes de publicar, então a loja confirma a ação
  na própria tela.
- Dado que a operação falha, quando ter a resenha moderada antes de publicar, então vejo o motivo e o
  que fazer a seguir.
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
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
