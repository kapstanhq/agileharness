---
id: story-nota-estrelas
type: story
title: Dar nota em estrelas
storyType: user
status: concluida
parent: step-nota
release: r1
personas:
- leitor
systems:
- checkout
links: []
narrative:
  role: leitora que compra livros na loja
  want: dar nota em estrelas
  soThat: registro o que achei da leitura
acceptance:
- Dado que estou na loja, quando dar nota em estrelas, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando dar nota em estrelas, então vejo o motivo e o que fazer a seguir.
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
