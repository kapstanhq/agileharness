---
id: story-cupom-aplicar
type: story
title: Aplicar um cupom de desconto
storyType: user
status: design-ui
parent: step-cupom
release: r1
personas:
- livreiro
systems:
- busca
links: []
narrative:
  role: livreiro que opera a loja
  want: aplicar um cupom de desconto
  soThat: uso os descontos a que tenho direito
acceptance:
- Dado que estou na loja, quando aplicar um cupom de desconto, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando aplicar um cupom de desconto, então vejo o motivo e o que fazer a
  seguir.
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
