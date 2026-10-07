---
id: story-pagamento-cartao
type: story
title: Pagar com cartão de crédito
storyType: user
status: pronta
parent: step-pagamento
release: r2
personas:
- colecionador
systems:
- checkout
links: []
narrative:
  role: colecionador de edições especiais
  want: pagar com cartão de crédito
  soThat: pago do jeito que prefiro, sem susto no fim
acceptance:
- Dado que estou na loja, quando pagar com cartão de crédito, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando pagar com cartão de crédito, então vejo o motivo e o que fazer a seguir.
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
