<!-- GERADO — edite pela view Estilo ou via refine; edição manual será sobrescrita no próximo approve. -->

---
meta:
  version: 1
  updatedAt: '2026-08-01T12:00:00.000Z'
  sources:
    refs: []
    prompt: Guia sintético do board de demonstração — existe para que o chokepoint de frontmatter tenha um guia REAL para ler.
identity:
  school: Sala de leitura à noite — fundo verde-garrafa, luz de abajur, metal fosco.
  personality:
    - acolhedor
    - paciente
    - atento
    - discreto
  prose: A loja fecha, a luz baixa e sobra a mesa do livreiro. A tela deve ter essa calma, com a capa em primeiro plano.
principles:
  items:
    - 'Capa inteira, sempre: nenhuma imagem de livro é recortada para caber no grid.'
    - 'A sinopse aparece antes de qualquer selo, faixa ou promoção no cartão do livro.'
    - 'Escuro por padrão, claro por escolha — e os dois passam AA.'
    - 'Estoque baixo fala em texto («restam 2»), nunca só em cor.'
  prose: Quando dois princípios puxarem para lados opostos, vale o que evita o leitor comprar o livro errado.
color:
  tokens:
    - role: night
      value: '#14201C'
      usage: fundo geral, verde-garrafa quase preto.
      'on': '#EDE6D3'
    - role: lamp
      value: '#EDE6D3'
      usage: texto de corpo, títulos e traço de ícone.
      'on': '#14201C'
    - role: shelf-line
      value: '#2B3B34'
      usage: filete de 1px entre linhas de lista e contorno de cartão.
    - role: brass
      value: '#C9A24B'
      usage: foco de teclado, preço e o botão de reservar — metal fosco, nunca brilho.
      'on': '#14201C'
      budget: no máximo 3 elementos de latão por tela visível
    - role: stock-low
      value: '#E08E6B'
      usage: apoio ao texto «restam N» — nunca sozinho.
      'on': '#14201C'
  budgetRules:
    - Latão não preenche faixa nem cabeçalho; só botão, preço e foco.
    - O aviso de estoque sempre vem com número.
  prose: Duas tintas de papel e um metal. Uma cor nova só entra com par de contraste conferido.
typography:
  fonts:
    - role: display
      family: Archivo Narrow
      usage: nome da obra e do autor, em caixa de título.
    - role: body
      family: Atkinson Hyperlegible
      usage: sinopse, ficha técnica e interface.
  scale:
    - id: obra
      size: 26px/1.15
      weight: 600
      rule: 1 por tela, o título do livro em foco.
    - id: sinopse
      size: 16px/1.6
      weight: 400
      rule: linhas de no máximo 60 caracteres.
  rules:
    - Número de preço e de estoque usa algarismos tabulares.
  prose: ''
spacing:
  base: 4
  steps:
    - 4
    - 12
    - 20
    - 32
    - 56
  prose: Cartões de livro ficam a 12 entre si; seções, a 56.
shape:
  radii:
    capa: 2px
    botao: 6px
  depth: Sem sombra; a separação vem do filete shelf-line.
  borders: 1px shelf-line em cartões; 2px brass no foco.
  prose: ''
antiPatterns:
  - symptom: Capa cortada em círculo ou em proporção fixa
    fix: manter a proporção original e deixar o grid se adaptar.
  - symptom: Selo de promoção cobrindo parte da sinopse
    fix: mover o selo para a linha do preço.
---

## Cor [color]

Verde-garrafa de fundo, creme de texto, latão só onde há decisão. O coral do estoque baixo é apoio, nunca o aviso.

## Tipografia [typography]

Uma condensada para o nome da obra e uma humanista legível para todo o resto.

## Espaçamento [spacing]

Base 4. Seções a 56, cartões a 12.

## Forma [shape]

Cantos quase retos e filetes finos; a sombra não existe neste guia.
