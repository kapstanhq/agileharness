<!-- GERADO — edite pela view Estilo ou via refine; edição manual será sobrescrita no próximo approve. -->

---
meta:
  version: 1
  updatedAt: '2026-08-01T12:00:00.000Z'
  sources:
    refs: []
    prompt: Guia sintético do board de demonstração — existe para que o chokepoint de frontmatter tenha um guia REAL para ler.
identity:
  school: Papel e tinta — tipografia serifada, fundo creme, zero sombra.
  personality:
    - calmo
    - letrado
    - direto
  prose: Uma livraria não é um dashboard. A tela imita a página impressa; a interface some atrás do texto.
principles:
  items:
    - 'Uma cor de destaque só: o vermelho da lombada, reservado a preço e ação principal.'
    - Hierarquia por tamanho e peso, nunca por cor.
    - 'Espaço generoso: a capa respira, o texto tem medida de leitura (65 caracteres).'
  prose: Em conflito, o item de índice menor vence.
color:
  tokens:
    - role: canvas
      value: '#F5F1E8'
      usage: fundo de papel creme atrás do conteúdo.
    - role: foreground
      value: '#1F1B16'
      usage: texto de corpo e títulos.
      'on': '#F5F1E8'
    - role: accent
      value: '#8C2F26'
      usage: preço e ação principal — nunca em texto de corpo.
      'on': '#FFFFFF'
      budget: ≤5% da área da tela
typography:
  fonts:
    - role: body
      family: Source Serif
      usage: corpo e sinopse.
    - role: display
      family: Source Serif
      usage: títulos e capas.
spacing:
  base: 8
  steps:
    - 8
    - 16
    - 24
    - 40
---

## Cor [color]

O creme é a moldura; o vermelho da lombada é o único acento. Um segundo acento é regressão, não variação.

## Tipografia [typography]

Uma família só, dois pesos. A medida de leitura manda no layout, não o contrário.

## Espaçamento [spacing]

Base 8. O respiro entre blocos nunca é menor que 24.
