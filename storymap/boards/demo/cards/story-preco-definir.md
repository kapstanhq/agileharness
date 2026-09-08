---
id: story-preco-definir
type: story
title: Definir o preço de um título
storyType: user
status: arquivados
parent: step-precos
release: r2
personas:
- colecionador
systems:
- entrega
links: []
narrative:
  role: colecionador de edições especiais
  want: definir o preço de um título
  soThat: ajusto o preço sem depender de alguém
acceptance:
- Dado que estou na loja, quando definir o preço de um título, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando definir o preço de um título, então vejo o motivo e o que fazer a
  seguir.
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
order: 10
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
