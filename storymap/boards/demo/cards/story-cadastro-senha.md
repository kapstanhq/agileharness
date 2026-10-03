---
id: story-cadastro-senha
type: story
title: Recuperar a senha
storyType: user
status: com-design
parent: step-cadastro
release: r2
personas:
- leitor
systems:
- catalogo
links: []
narrative:
  role: leitora que compra livros na loja
  want: recuperar a senha
  soThat: entro na loja sem atrito e sem perder o acesso
acceptance:
- Dado que estou na loja, quando recuperar a senha, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando recuperar a senha, então vejo o motivo e o que fazer a seguir.
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
order: 30
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
