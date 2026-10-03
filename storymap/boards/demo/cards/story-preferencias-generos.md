---
id: story-preferencias-generos
type: story
title: Escolher os meus gêneros favoritos
storyType: user
status: desenvolver
parent: step-preferencias
release: r1
personas:
- colecionador
systems:
- contas
links: []
narrative:
  role: colecionador de edições especiais
  want: escolher os meus gêneros favoritos
  soThat: a loja fala comigo do jeito que eu quero
acceptance:
- Dado que estou na loja, quando escolher os meus gêneros favoritos, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando escolher os meus gêneros favoritos, então vejo o motivo e o que fazer
  a seguir.
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
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
