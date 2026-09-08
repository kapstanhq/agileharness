---
id: story-amostra-primeiras-paginas
type: story
title: Ler as primeiras páginas
storyType: user
status: merge
parent: step-amostra
release: r1
personas:
- colecionador
systems:
- entrega
links: []
narrative:
  role: colecionador de edições especiais
  want: ler as primeiras páginas
  soThat: experimento o texto antes de comprar
acceptance:
- Dado que estou na loja, quando ler as primeiras páginas, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando ler as primeiras páginas, então vejo o motivo e o que fazer a seguir.
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
