---
id: story-frete-opcoes
type: story
title: Comparar prazo e preço de frete
storyType: user
status: plano-tecnico
parent: step-frete
release: r2
personas:
- leitor
systems:
- entrega
links: []
narrative:
  role: leitora que compra livros na loja
  want: comparar prazo e preço de frete
  soThat: escolho entre preço e prazo com a informação na mão
acceptance:
- Dado que estou na loja, quando comparar prazo e preço de frete, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando comparar prazo e preço de frete, então vejo o motivo e o que fazer
  a seguir.
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
