---
id: story-estoque-entrada
type: story
title: Registrar a entrada de estoque
storyType: user
status: release
parent: step-estoque
release: r1
personas:
- leitor
systems:
- busca
links: []
narrative:
  role: leitora que compra livros na loja
  want: registrar a entrada de estoque
  soThat: não vendo o que não tenho
acceptance:
- Dado que estou na loja, quando registrar a entrada de estoque, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando registrar a entrada de estoque, então vejo o motivo e o que fazer
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
