---
id: story-recomendacao-similar
type: story
title: Ver livros parecidos com um que gostei
storyType: user
status: ready
parent: step-recomendacao
release: r1
personas:
- livreiro
systems:
- checkout
links: []
narrative:
  role: livreiro que opera a loja
  want: ver livros parecidos com um que gostei
  soThat: encontro livros parecidos com os que já gostei
acceptance:
- Dado que estou na loja, quando ver livros parecidos com um que gostei, então a loja confirma a ação
  na própria tela.
- Dado que a operação falha, quando ver livros parecidos com um que gostei, então vejo o motivo e o que
  fazer a seguir.
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
