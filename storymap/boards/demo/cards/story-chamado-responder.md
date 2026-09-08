---
id: story-chamado-responder
type: story
title: Responder um chamado
storyType: user
status: enriquecer
parent: step-chamado
release: r1
personas:
- livreiro
systems:
- catalogo
links: []
narrative:
  role: livreiro que opera a loja
  want: responder um chamado
  soThat: um problema vira uma conversa rastreável
acceptance:
- Dado que estou na loja, quando responder um chamado, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando responder um chamado, então vejo o motivo e o que fazer a seguir.
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
order: 20
created: '2026-08-01'
updated: '2026-08-01'
findings:
- id: f1
  lens: ux
  severity: minor
  status: open
  title: O estado vazio não explica o que fazer a seguir
questions:
- id: q1
  text: Vale cobrir o caso offline nesta fatia?
  status: open
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
