---
id: story-carrinho-adicionar
type: story
title: Adicionar um livro ao carrinho
storyType: user
status: grill
parent: step-carrinho
release: r1
personas:
- leitor
systems:
- contas
links: []
narrative:
  role: leitora que compra livros na loja
  want: adicionar um livro ao carrinho
  soThat: junto o que quero e reviso antes de pagar
acceptance:
- Dado que estou na loja, quando adicionar um livro ao carrinho, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando adicionar um livro ao carrinho, então vejo o motivo e o que fazer
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
