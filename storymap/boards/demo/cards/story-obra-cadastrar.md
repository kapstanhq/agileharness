---
id: story-obra-cadastrar
type: story
title: Cadastrar um título novo
storyType: user
status: revisao
parent: step-cadastrar-obra
release: r2
personas:
- livreiro
systems:
- checkout
links: []
narrative:
  role: livreiro que opera a loja
  want: cadastrar um título novo
  soThat: coloco um título novo à venda em minutos
acceptance:
- Dado que estou na loja, quando cadastrar um título novo, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando cadastrar um título novo, então vejo o motivo e o que fazer a seguir.
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
