# Decisões SCAMPER: o que aconteceu com cada tela e função

Este documento registra, tela por tela e função por função, o que mudou na ferramenta desde a **v0.9.57**:
o que ficou, o que mudou de lugar, o que foi escondido e o que saiu. Serve para quem conhecia a versão antiga
e procura algo que não acha mais, e para quem vai mexer na ferramenta e quer saber por que ela é assim.

## Como ler

**SCAMPER** é um roteiro de perguntas para repensar cada parte de um produto. Cada letra é um verbo:

| Verbo | A pergunta |
|---|---|
| **Substituir** | Dá para trocar isto por algo mais simples que faça o mesmo trabalho? |
| **Combinar** | Isto pode virar uma coisa só com outra parte que já existe? |
| **Adaptar** | Dá para aproveitar uma ideia que funciona em outro lugar? |
| **Modificar** | O que muda no texto, no tamanho ou no comportamento para servir melhor? |
| **Dar outro uso** | O dado ou a ação servem melhor a outro propósito? |
| **Eliminar** | Se isto sumir, alguém sente falta? |
| **Reorganizar** | Isto está no lugar e na ordem certos? |

Usamos também dois vereditos que não são letras do SCAMPER, mas aparecem muito: **Manter** (fica como está) e
**Esconder** (continua existindo, mas sai do caminho da pessoa: vai para "Mais detalhes", para a engrenagem ou
fica só para os agentes).

**A regra dos quatro grupos.** A navegação tem quatro grupos, e cada um é **uma página que mostra e edita um
arquivo Markdown do board**:

| Grupo | Página | Arquivo |
|---|---|---|
| Negócio | Business Model Canvas (9 blocos) | `docs/business-model-canvas.md` |
| Produto | PRD de negócio | `docs/prd.md` |
| Design | Guia de estilo | `design/style-guide.md` |
| Software | Kanban | os cards (`cards/*.md`) |

Toda tela precisava caber num desses grupos ou num dos três lugares de apoio: o **Inbox** (o que espera a
pessoa), a **engrenagem** (sistema e configuração) e o **chat** (o compositor do rodapé). O que não cabia e não
servia para orquestrar o trabalho saiu ou foi escondido.

**Colunas.** "Onde ficou" usa: Negócio, Produto, Design, Software (Kanban e card), Inbox, Engrenagem, Chat,
Removido ou Escondido. "Fase/versão" diz quando a mudança chegou:

| Valor | O que entrou |
|---|---|
| v0.10.0 | fase 1: barra do topo nova, Kanban novo, chat no rodapé, Início eliminado |
| v0.11.0 | fase 3: Inbox refeito, Esteira apagada |
| v0.12.0 | fase 4: Autonomia num controle só |
| v0.13.0 | fase 2: quatro grupos, BMC, PRD de negócio, guia de estilo numa página |
| v0.13.1 / v0.13.2 | correções vistas em uso (Kanban abre em «Tudo», saúde respeita a pausa, ajustes do chat) |
| próxima versão | fases 6 (agentes), 5 (limpeza) e 7 (funcionalidades do PRD e lotes do condutor): em construção |
| backlog | decidido, ainda sem data |
| — | nada mudou |

---

## 1. Navegação e telas do board

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Barra de navegação antiga (abas de bloco, miniaturas no popover) | Substituir | Barra do topo com logo, projeto e grupo; à direita, cota, Inbox e engrenagem. O seletor de grupo lista só os quatro grupos | Software | v0.10.0, v0.13.0 |
| Início (feed do board) | Eliminar | A ferramenta abre no Kanban. O que pedia ação foi para o Inbox; o que só informava, para a atividade do Kanban | Removido | v0.10.0 |
| Raiz do app e do board | Modificar | Abrem o Kanban do board | Software | v0.10.0 |
| Kanban | Modificar | Seis raias com o fluxo no cabeçalho; um card por funcionalidade, com os itens expansíveis; estados claros (erro, precisa de você, rodando); segunda barra com ritmo, atividade, busca e «Mostrar» | Software | v0.10.0 |
| Recorte «Exceções / Tudo» do Kanban | Modificar | Abre em «Tudo»; a escolha fica lembrada por board neste navegador | Software | v0.13.1 |
| Kanban em tela baixa | Modificar | Compositor de uma linha e faixa do fluxo compacta; as caixinhas que se sobrepõem e a legenda cortada no modo compacto saem na limpeza | Software | v0.11.0, próxima versão |
| Ordem dos cards na coluna | Substituir | A posição na coluna é a ordem do trabalho (antes a coluna ordenava pela data do arquivo). O menu do card ganha «Fazer antes» (vai ao topo) e «Pode esperar» (vai ao fim) | Software | próxima versão |
| Lean Canvas | Substituir | Business Model Canvas de 9 blocos na grade clássica (lista no celular). Migração automática sem perder conteúdo; o original vai para `docs/.archive/`. A rota antiga redireciona | Negócio | v0.13.0 |
| Posicionamento | Combinar | Vira a Proposta de valor do PRD. A rota antiga redireciona | Produto | v0.13.0 |
| PRD de dezesseis seções | Substituir | PRD de negócio com sete seções e nenhuma tecnologia: problema, personas, proposta de valor, funcionalidades, fluxo de uso, métricas de sucesso, fora do escopo. Migração automática; original arquivado | Produto | v0.13.0 |
| Seções técnicas do PRD (decisões, pronto quando, requisitos, restrições, riscos, glossário) | Dar outro uso | Vão para `docs/contexto.md`, sem página: os agentes leem e mantêm; o que toca decisão do dono vai ao Inbox | Escondido | v0.13.0 |
| Guia de estilo (modos Estruturado e Doc) | Modificar | Uma página só, um documento: Tom, Cores, Tipografia, Estética, Componentes (novo); Anti-padrões e Dívidas recolhidos no fim. O tom é do dono; o resto os agentes mantêm, com checagem de contraste | Design | v0.13.0 |
| Trocador de vistas dos documentos (documento, markdown, tabela, quadro) | Eliminar | Cada documento tem uma vista fixa e um botão Editar/Salvar | Negócio, Produto, Design | v0.13.0 |
| Trilho lateral do chat nas páginas de documento | Combinar | O chat é o compositor do rodapé, que recebe o assistente do documento aberto | Chat | v0.13.0 |
| Mapa de histórias (tela) | Eliminar | A tela foi apagada; o link antigo leva ao Kanban | Removido | v0.13.0 |
| Mapa de histórias (dado: atividade, passo, história) | Dar outro uso | Vira a "funcionalidade" que agrupa os cards no Kanban | Software | v0.10.0 |
| Faixa do resultado-alvo | Eliminar | A meta vem das Métricas de sucesso do PRD | Removido | v0.13.0 |
| Fatia de release do card | Esconder | Sem tela; o campo continua no card para quem usa | Escondido | v0.13.0 |
| Selos do card antigo (inclusive "sem lugar no mapa") | Eliminar | O estado do card no Kanban novo diz o que importa | Removido | v0.10.0 |
| Ideias (bancada) | Combinar | Ideia vira item da Triagem. O link antigo leva ao Kanban | Software | v0.13.0 |
| Cards de ideia já existentes | Combinar | Migrados para a Triagem na leitura, sem reescrever arquivos | Software | próxima versão |
| Página da ideia | Eliminar | Duplicava a página do card; o link antigo leva ao card | Removido | v0.13.0 |
| Personas & Sistemas | Combinar / Esconder | Personas viram a seção Personas do PRD (só o dono muda; agentes propõem). Sistemas viram contexto que o chat mantém. O link antigo leva ao Produto | Produto, Escondido | v0.13.0 |
| Página da persona ou do sistema | Eliminar | Uma persona é um subtítulo do PRD | Removido | v0.13.0 |
| Priorização (tela, ordem por WSJF, gráfico valor × tamanho) | Eliminar | Sem pontuação: a ordem é a posição na coluna. O link antigo leva ao Kanban | Removido | próxima versão |
| Esteira | Reorganizar, depois Eliminar | As alavancas foram para o Inbox (publicação segurada com o motivo, «Publicar mesmo assim», «Cancelar», «Refazer o pedido agora», «Stage parado há N h»); depois a tela saiu. O link antigo leva ao Inbox | Inbox | v0.11.0 |
| Acompanhar | Combinar | Vira «Os agentes estão cuidando (N)», uma linha recolhida no fim do Inbox, com o registro das decisões do sistema | Inbox | v0.11.0 |
| Fila de perguntas | Combinar | Cada pergunta vira um item do Inbox, com as respostas como botões de um clique. O link antigo leva ao Inbox | Inbox | v0.11.0 |
| Inbox (todos os boards, um board, página do item) | Substituir | Refeito do zero. Cada item: o que aconteceu, o que o agente precisa de você, opções de um clique, «Mais detalhes» recolhido. Recibo com Desfazer, sem diálogo de confirmação | Inbox | v0.11.0 |
| Itens de saúde e de trava da cota | Adaptar | Viram itens do Inbox com a ação que destrava | Inbox | v0.11.0 |
| Aviso «ative o aviso no celular» | Adaptar | Item do Inbox quando nenhum aparelho recebe avisos; o celular só toca para o que é crítico | Inbox | v0.11.0 |
| Métricas | Combinar | O custo fica no card e no popover da cota. O link antigo leva ao Kanban | Removido | v0.13.0 |
| Orquestração › Skills (editor de skill) | Eliminar | O editor gravava a skill direto no checkout em uso, sem revisão. Mudar uma skill é um pedido ao chat, que trabalha numa worktree e entrega pelo trem | Chat | v0.13.0 |
| Orquestração › Assistentes e Rotas & Especialistas | Eliminar / Esconder | Ficam os assistentes dos três documentos; o resto vira configuração só de leitura ou some. Entradas órfãs do registro de assistentes saem | Escondido | v0.13.0, próxima versão |
| Criar card (tela própria) | Substituir | Criar é `/criar` no chat, ou pela Triagem. A tela foi apagada; o link antigo leva ao Kanban | Chat | v0.10.0 (`/criar`), próxima versão (tela apagada) |
| Resumo da semana | Manter | Página que mostra o que foi ao ar, o que foi descartado, o que o sistema decidiu e o custo. Comando `/resumo` no chat e cartão fixo no Inbox | Inbox, Chat | —, backlog |
| Processos | Esconder | Linha na engrenagem | Engrenagem | v0.10.0 |
| Terminal | Manter, separado | Linha na engrenagem; quem quer abre vários. O chat lista, lê, manda mensagem e encerra terminais, com confirmação | Engrenagem, Chat | v0.10.0, próxima versão |
| Laboratório do overlay de feedback | Eliminar | Rota de teste que ficou para trás | Removido | próxima versão |
| Overlay de feedback (pílula fixa no canto) | Esconder + Adaptar | Sai do canto de toda página; vira «Marcar ajuste» na engrenagem, e o que se marca vira item na Triagem | Engrenagem | v0.11.0 |
| Login | Manter | — | Software | — |

## 2. Página do card

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Casca do card (abas Documento, Markdown, Campos, Editar) | Modificar | Uma vista: o que é, em que pé está, o que espera de você e a prova. Os campos técnicos ficam em «Detalhes técnicos», recolhido | Software | próxima versão |
| Faixa de status do card | Substituir | Cabeçalho com a mesma anatomia do Inbox quando há decisão pendente; sem decisão, só a linha ao vivo | Software | próxima versão |
| Ações rápidas do card (Terminal, Diff, Avançar) | Esconder / Eliminar | Terminal e Diff em «Detalhes técnicos». Avançar sai: quem avança é o fluxo; a pessoa aprova o que o Inbox pede | Escondido | próxima versão |
| Norte do PRD e linha do run no topo do documento | Eliminar / Esconder | O PRD mora em Produto; a linha do run vai para «Detalhes técnicos» | Escondido | próxima versão |
| Narrativa e critérios de aceite | Manter | No topo. Para mudar, pede-se ao chat | Software | — |
| Corpo livre e «Prova da entrega» | Reorganizar | A prova sobe para o topo quando o card espera a aprovação da entrega | Software | próxima versão |
| Canvas de design no card | Manter (condicional) | Ações só quando a escolha da tela é sua; senão aparece como registro | Software, Inbox | v0.12.0 |
| Notas de execução (plano técnico) | Esconder | Em «Detalhes técnicos» | Escondido | próxima versão |
| Bloqueios, avisos e achados | Modificar | Contagem e rastro do que o agente triou; botões só para decisão sua | Software | próxima versão |
| Seção de priorização (RICE, KANO, funil, chamada de prioridade) | Eliminar | Sem pontuação | Removido | próxima versão |
| Histórico de etapas e linha do tempo de saltos | Combinar | Uma linha do tempo em português simples, filtrada pelo card | Software | backlog |
| Retirada do card (lápide) | Modificar | A lápide fica; aprovar a exclusão de dados tem uma porta só, o Inbox | Software, Inbox | v0.11.0 |
| Estado ao vivo do card | Manter | Base do card do Kanban | Software | v0.10.0 |
| Campos › Classificação (seletores de status e tipo) | Eliminar / Manter | O seletor de status era um segundo jeito de mover sem as checagens; o tipo fica só de leitura | Escondido | próxima versão |
| Campos › Antes de construir (preferência técnica, «quero ver as telas») | Reorganizar | Perguntados no `/criar`; «quero ver as opções de tela deste card» fica como pedido por card, fora da Autonomia | Software, Chat | v0.12.0, backlog |
| Campos › Narrativa, Links, Rota, Lugar | Esconder | Em «Detalhes técnicos»; problema de lugar vira pergunta no Inbox | Escondido | próxima versão |
| Campos › criar persona ou sistema na hora | Substituir | Personas vêm do PRD | Produto | v0.13.0 |
| Campos › Tarefas (edição) | Eliminar | Mostra só o progresso | Software | próxima versão |
| Selo «ultra / humano» do card | Eliminar | A autonomia é do board, num controle só | Removido | v0.12.0 |
| Mover para | Modificar | Vai para o menu do card e para o chat; o botão principal é a opção que o card espera de você | Software | v0.10.0 |
| Sincronizar card | Dar outro uso | Só lê e diagnostica; não reescreve o card nem o move | Software, Chat | v0.13.2 |
| Refinar (janela) | Modificar | Texto e print opcional; a skill de refino decide o caminho. Entrada pelo chat (`/melhorar`) | Chat | backlog |
| Reportar bug (janela) | Modificar | Relato, print e gravidade opcional; a skill de correção decide o caminho. Entrada pelo chat (`/bug`) | Chat | backlog |
| Descontinuar e Adiar | Combinar | Uma ação «Tirar do caminho» com duas saídas: «Não agora» (reversível) ou «Tirar do produto» | Software, Chat | backlog |
| Excluir card | Manter, escondido | No menu do card, com lixeira de 7 dias | Software | — |
| Captura inteligente (janela) | Substituir | `/criar` abre a captura; a proposta volta na conversa ou no Inbox | Chat, Inbox | v0.10.0, backlog (assíncrona) |
| Árvore da proposta de captura | Manter | É o corpo do item de captura | Inbox | v0.11.0 |
| Ações rápidas de um clique | Manter | Sem diálogo de confirmação | Inbox | v0.11.0 |
| Menus do card antigo (mover, ações, diff, console) | Reorganizar / Esconder | O menu do card no Kanban novo cobre; console e diff em «Detalhes técnicos» | Software, Escondido | v0.10.0 |
| Parar condutor / Devolver ao fluxo | Adaptar | Dois botões no card com condutor e no item «o condutor encerrou e ninguém assumiu» | Software, Inbox | próxima versão |

## 3. O fluxo (pipeline) como a pessoa vê

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Seis raias com passos dentro | Reorganizar | O cabeçalho de cada raia mostra o fluxo; os passos aparecem como trilha | Software | v0.10.0 |
| Capturando | Manter + Esconder | A proposta chega pelo chat ou pelo Inbox | Escondido | v0.10.0 |
| Triagem e juiz de triagem | Adaptar | Recebe também ideias e ajustes marcados na tela | Software, Inbox | v0.13.0 |
| Dúvidas (grill) | Combinar | As perguntas viram «Precisa de você» no card e itens do Inbox | Software, Inbox | v0.11.0 |
| Especificar (enriquecer) | Manter | Porta de entrada do condutor | Software | — |
| Entrevista | Dar outro uso | Continua para o modo por colunas; com condutor, é parte do trabalho dele | Software | próxima versão |
| Estimar (priorizar) e a skill de priorização | Eliminar | O passo sai; «A fazer» passa a exigir só o refinamento. Um board que ainda declara o gate antigo de priorização é lido como refinamento, e a nota antiga num card não é mais lida | Removido | próxima versão |
| A fazer (pronta) | Modificar | É o ponto do «vai». Com condutor, quem aprova o plano é um crítico independente; em Mínima, é você | Software, Inbox | v0.12.0, próxima versão |
| Jornada e Telas | Combinar | Um passo «Desenhar»; a escolha da tela vira item do Inbox com as variantes como botões | Software, Inbox | v0.11.0, backlog (fusão) |
| Pronto para dev | Eliminar | O «vai» já foi dado em «A fazer» | Software | próxima versão (sem execução automática), backlog (remoção) |
| Colunas intermediárias sem uso com condutor (dúvidas, entrevista, jornada, telas, revisão de código, pronto para dev) | Modificar | Em boards com condutor (o padrão), perdem a execução automática; seguem existindo para quem escolhe o modo por colunas (`pipeline: columns`), e as skills seguem como comando manual | Software | próxima versão |
| Plano, Desenvolver, Revisão, QA | Esconder | Aparecem como «Construindo / Verificando» com a barra de passos | Software | v0.10.0 |
| Passo manual parado | Modificar | Vira item do Inbox («este passo espera você mandar rodar») | Inbox | v0.11.0 |
| Aprovar entrega | Manter | Item do Inbox com o antes, o depois e a prova; governado pela caixa «aprovar a entrega» e travado em código | Inbox | v0.11.0, v0.12.0 |
| Integrar e Homologar | Esconder | Um estado só, «Integrando», com o trem na raia Entrega | Software | v0.10.0 |
| Liberar e Publicar | Combinar | Para a pessoa, «Pronto para publicar» e «Publicando»; um item «Publicação» por board com a causa | Software, Inbox | v0.11.0 |
| Novidades em No ar | Adaptar | O que acabou de ir ao ar aparece na raia No ar | Software | v0.10.0 |
| Refinar, Corrigir, Descontinuar (raias de volta) | Combinar (entrada) | Entrada única pelo chat (`/bug`, `/melhorar`, `/remover`); as skills ficam | Chat | backlog |
| Status de arquivo e Lixeira | Manter + Esconder | Lixeira na engrenagem | Engrenagem | v0.10.0 |
| Condutor × execução por coluna | Substituir (parcial) | Board novo nasce com condutor; as skills de coluna viram o roteiro e o plano B | Software | próxima versão |
| Fila do condutor | Substituir | A vez é a posição do card na coluna «A fazer» (FIFO no empate); só fatos do card passam à frente: a gravidade de um bug e o rótulo de segurança ou de dados de pessoas. Sem nota de prioridade | Software | próxima versão |
| Texto de recusa dos gates e da descrição das colunas | Modificar | Separar o texto para a pessoa do texto para o agente | Software | backlog |
| Perfis de rota | Esconder | Só para agentes | Escondido | — |
| Procurador do dono e sua auditoria | Modificar | Procurador cego (não vê a recomendação de quem pergunta) e com escopo; auditorias por amostra feitas por revisores independentes, fora do Inbox do dono | Escondido | v0.12.0, próxima versão |
| Auditoria de entrega e auditoria técnica | Combinar + Esconder | Fecham o ciclo: auditoria segura a publicação por pouco tempo; reabrir uma entrega gera card de refino; vencimento vai para o resumo | Escondido | próxima versão |
| Rascunhos de mudança em documento do dono | Manter | Item do Inbox com o diff da seção do PRD ou do BMC | Inbox | v0.13.0 |
| Registro de decisões do sistema | Combinar | Em «Os agentes estão cuidando», com Desfazer | Inbox | v0.11.0 |
| Comando travado (só o dono aprova) | Manter | Só no Inbox, sempre do dono, «Aprovar e rodar» uma vez | Inbox | — |
| Itens de publicação (falhou, segurada, sem confirmação, envelhecida) | Combinar | Um item «Publicação» por board, com a causa e a ação | Inbox | v0.11.0 |
| Conflito de merge | Substituir | O agente tenta resolver primeiro; a pessoa só vê quando ele desiste | Inbox | v0.11.0 |
| Pedido de orçamento e ciclo extra | Manter | Sob a caixa «passar do teto de gasto»; acima do teto, a decisão de dinheiro é do dono | Inbox | v0.12.0 |
| Skills fora do fluxo (tarefas, ship, story, tests) | Eliminar / Combinar / Dar outro uso | Saem do caminho; testes viram subagente | Removido | backlog |

## 4. Sistema e configuração (engrenagem)

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Autonomia espalhada (níveis do Jido, matriz de risco, modo ultra/humano, autorun por coluna, publicação automática) | Substituir | Um controle só, «Autonomia», com dois modos prontos (Mínima e Máxima) e caixas de marcar entre eles. Pílula na barra do topo e a mesma seção na engrenagem; nenhuma outra tela configura autonomia | Engrenagem | v0.12.0 |
| Caixas da Autonomia | Adaptar | Aprovar a especificação (o crítico aprova o plano), escolher a tela, aprovar a entrega, publicar, fazer deploy, passar do teto de gasto, o Jido agir sem você pedir, a Sentinela consertar a máquina sozinha (em Mínima ela só diagnostica) | Engrenagem | v0.12.0, próxima versão (Sentinela e crítico do plano) |
| «Sempre seus, em qualquer modo» | Adaptar | Lista travada, sem caixa: dinheiro e preço, falar pela marca, o PRD e as metas, dados de pessoas, e os comandos que a trava dura proíbe | Engrenagem | v0.12.0 |
| Configurações › Autopilot | Esconder + Combinar | O que era autonomia foi para o controle novo; o resto fica em Configurações | Engrenagem | v0.12.0 |
| Configurações › Jido (níveis e matriz) | Eliminar / Combinar | Os níveis saíram; cadência e modelo ficam em Configurações | Engrenagem | v0.12.0 |
| Configurações › Toolkit & MCP | Dar outro uso | Leitura em Configurações; lacuna de ferramenta vira sinal de saúde | Engrenagem | —, backlog |
| Painel da cota | Reorganizar | O anel da barra abre o popover com custo e ritmo; trava presa vira item do Inbox | Engrenagem, Inbox | v0.10.0, v0.11.0 |
| Política por coluna (modelo, esforço, autorun) | Eliminar (da tela) | Fica no pipeline base; o «rodar sozinho» de cada passo é do pipeline e do ritmo do board | Escondido | v0.12.0 |
| Ritmo do board (normal, devagar, pausado) e escopo | Manter | Na segunda barra do Kanban; não é autonomia | Software | v0.10.0 |
| Saúde e alerta de memória | Modificar | Viram o anel e linhas na engrenagem; a saúde ignora boards pausados | Engrenagem | v0.10.0, v0.13.2 |
| Deriva do sistema | Substituir | Sincronizar é técnico: automático dentro do teto, registrado | Inbox | v0.12.0 |
| Notificações | Modificar | Som, navegador e celular na engrenagem; o celular só toca para o crítico | Engrenagem, Inbox | v0.11.0 |
| Lixeira | Manter, escondido | Na engrenagem | Engrenagem | v0.10.0 |
| Tema (botão solto de claro/escuro) | Modificar | A troca fica no rodapé da engrenagem | Engrenagem | v0.10.0 |
| Modo econômico | Substituir | Hoje é um interruptor na engrenagem; o plano é o governador da cota ligar sozinho e deixar recibo | Engrenagem | backlog |
| Recarregar | Eliminar | O board já se atualiza sozinho a cada evento | Engrenagem | backlog |
| Login e Sair | Manter | — | Engrenagem | — |

## 5. Agentes e chat

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Chat do Jido (painel e trilho lateral) | Reorganizar | Compositor no rodapé de toda página, abre por cima da tela | Chat | v0.10.0 |
| Jido com um papel só (conversa e vigia no mesmo agente, acordando por relógio) | Substituir | Dividido em dois, com o mesmo rosto: a **Sentinela**, que acorda por evento quando algo sai do trilho, conserta primeiro sem IA e só então abre uma sessão curta; e o **chat**, a central de comando | Chat, Escondido | próxima versão |
| Poderes da Sentinela | Adaptar | Mínima: só diagnostica e abre item no Inbox com «Resolver no chat». Máxima: conserta com shell sob a trava dura, com registro e teto diário de gasto | Escondido, Inbox | próxima versão |
| Chat como central de comando | Modificar | Poderes amplos sob a trava dura e com registro; conversa curta em português simples; propõe e faz, e pede confirmação antes do irreversível, do caro e do que é do dono | Chat | próxima versão |
| Jido isolado | Modificar | O chat roda em sessão própria, separada dos terminais | Chat | v0.13.2 |
| Comandos do compositor | Adaptar | `/criar` e as superfícies dos documentos; `/pendente`, `/resumo` e `/travou` como leituras sem custo de modelo | Chat | v0.10.0, backlog |
| Superfícies do chat (PRD, canvas, ideias, vocabulário) | Reorganizar | Viram Negócio, Produto e Design | Chat | v0.13.0 |
| Assistentes de ideia, persona e sistema | Eliminar | As técnicas úteis passam ao assistente de documentos | Removido | v0.13.0, próxima versão |
| Condutor (um agente por card, ponta a ponta) | Modificar | Lê um pacote de contexto enxuto; Sonnet para bug e manutenção, Opus para história de usuário e risco alto; fila pela posição na coluna | Software | próxima versão |
| Revisores independentes | Adaptar | Crítico do plano antes do código, revisor do diff e dos testes, verificador da entrega antes de publicar, todos lançados pelo serviço com contexto limpo | Escondido | próxima versão |
| Mudar teste existente | Modificar | Vai a um revisor que lê o diff, nunca ao procurador | Escondido | próxima versão |
| Atribuição por papel | Modificar | Cada ação registra quem agiu (condutor, Sentinela, chat, procurador, crítico) | Escondido | próxima versão |
| Caixa de correio do card | Adaptar | Toda ação do dono num card com condutor vira evento e aviso à sessão viva; o condutor obedece ou contrapropõe no Inbox | Escondido | próxima versão |
| Faixa leve | Modificar | O motor avança o card depois de uma execução limpa de skill de coluna | Escondido | próxima versão |
| Textos que prometiam demais | Modificar | O Jido não «orquestra ponta a ponta»; o selo respeita a pausa do board | Software, Chat | próxima versão |
| Terminais do usuário | Manter | Continuam separados do chat | Engrenagem | — |
| Botões no topo do chat aberto (anexar imagem, «Contexto», conversas anteriores, conversa nova) | Manter | O desenho do chat aberto só tem «Fechar». Os quatro ficam de propósito: são funções que o chat já tinha e que não têm outro lugar (mandar uma captura de tela, ver o que o Jido está lendo, voltar a uma conversa, começar do zero) | Chat | v0.16.1 |
| Borda de foco no compositor | Manter | O desenho não mostra destaque no campo quando ele está ativo. A borda fica: quem usa teclado precisa ver onde está o cursor, e é a regra de acessibilidade de todo campo da ferramenta | Chat | v0.16.1 |

## 6. Superfície MCP (para agentes)

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Leitura de cards (`list_boards`, `list_cards`, `get_card`) | Modificar | Sem campos de priorização | Escondido | próxima versão |
| `move_card` | Modificar | A posição na coluna é a ordem | Escondido | próxima versão |
| `update_card` | Modificar | Sem `rice`, `kano`, `funnelStage`, `priorityCall` | Escondido | próxima versão |
| `create_card`, `report_issue`, `usm_capture`, `accept_triage` | Manter | Sustentam `/criar` e `/bug` | Escondido | — |
| `run_skill`, `enqueue`, `enqueue_batch` | Combinar | Um `enqueue` só | Escondido | backlog |
| `sync_card`, `refine_card`, `report_bug`, `discontinue_card` | Combinar | Um `reopen_card` com modo | Escondido | backlog |
| `defer_card`, `undefer_card`, `revive_card` | Combinar | Um modelo só de «não agora» | Escondido | backlog |
| `approve_qa`, `approve_review` | Combinar + Esconder | Só para o operador | Escondido | backlog |
| `ask_question`, `answer_question` | Modificar | A pergunta exige o formato do Inbox: contexto, pergunta, 2 a 4 opções, recomendação | Inbox | v0.11.0 |
| Ferramentas de dinheiro (`request_budget`, `request_extra_cycle`, custo, decisão) | Manter | Com auto-aprovação só dentro da caixa de teto | Escondido, Inbox | v0.12.0 |
| `set_card_route` | Modificar | Sem aviso de priorização | Escondido | próxima versão |
| Sidecars (`get_card_plan`, `get_card_retire_plan`, `get_card_wireframes`) | Combinar | Uma leitura de sidecar por tipo | Escondido | backlog |
| `choose_wireframe`, `design_feedback` | Manter / Eliminar | A escolha da tela passa pelo Inbox | Inbox | v0.11.0, backlog |
| `get_styleguide`, `read_doc`, `write_doc` | Modificar | Documentos BMC, PRD de negócio, contexto e guia de estilo | Negócio, Produto, Design | v0.13.0 |
| `propose_change`, `withdraw_change`, `list_pending_changes` | Modificar | Mirando as seções do PRD e do BMC | Inbox | v0.13.0 |
| Aprovar/recusar mudança e ação, auditoria do procurador | Combinar | Decisão pelo Inbox, só com credencial completa e nunca por sessão de agente | Inbox | backlog |
| `set_card_autonomy` | Esconder | Exceção legada por card; vale só para especificação, design e entrega | Escondido | v0.12.0 |
| `board_autonomy` | Adaptar (nova) | Leitura do perfil de autonomia; não há ferramenta de escrita | Escondido | v0.12.0 |
| Ritmo e pausa (`set_board_autorun`, `board_pace`, `pause_board`, `resume_board`, trava da cota) | Combinar | Ficam ritmo, pausa e retomada | Escondido | backlog |
| Execução e sessões (`runner_status`, claims, console, cancelar, esperar) | Manter | — | Escondido | — |
| Publicação (`publish_when_idle`, `publish_status`, `resolve_merge`) | Manter | — | Escondido | — |
| Ideias (`create_idea`, `write_idea`, `update_idea`, `generate_tasks_for_idea`) | Combinar, depois Eliminar | `create_idea` vira atalho da captura: cria um card na Triagem (história de usuário sem lugar no mapa); as outras e a classe de escrita de ideia saem | Removido | próxima versão |
| Vocabulário | Combinar | Leitura e uma escrita só | Escondido | backlog |
| Saúde e contagens (`ah_health`, `intake_stats`, `rollout_readiness`, toques por história) | Combinar + Esconder | Uma leitura de saúde | Escondido | backlog |
| Leitura de código e git | Combinar + Esconder | Duas leituras com operação | Escondido | backlog |
| Ciclo de sessão (`worktree_*`, claims, `suggest_work`) | Manter / Modificar | `suggest_work` usa coluna e posição | Escondido | próxima versão |
| Terminais (`claude_*`, `session_*`, `run_task`) | Combinar / Eliminar | O chat usa essas ferramentas para ver e mandar nos terminais | Chat | próxima versão (uso pelo chat), backlog (fusão) |
| Texto de apresentação do MCP | Modificar | Sem RICE e sem Lean Canvas; gerado a partir do código | Escondido | v0.13.0, backlog |

## 7. Padrões que viraram regra

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Verbo específico no «Precisa de você» | Modificar | «Escolher a tela», «Aprovar a entrega», «Responder 2 perguntas» | Software | v0.11.0 |
| Linha «se ficar sem resposta» | Modificar | Uma linha discreta: o card espera. Nada segue sozinho com a sugestão | Inbox | v0.11.0 |
| Mostrar o que foi decidido | Modificar | Miniaturas como botões, resumo da prova, uma linha do que muda | Inbox | v0.11.0 |
| Sugerir mais autonomia pela evidência | Adaptar | O item só abre o painel com a caixa destacada; nunca grava sozinho; classes do dono nunca são oferecidas | Inbox | backlog |
| Disjuntor de revisões | Adaptar | Depois de recusas repetidas num card, vai ao Inbox: «os agentes não chegaram a um acordo» | Inbox | próxima versão |
| Vocabulário de quem age | Modificar | «Agente / Sistema / Você / Jido» | Software | v0.11.0 |
| Responder perguntas «em /perguntas» | Modificar | As skills dizem «no Inbox» | Inbox | v0.11.0 |

## 8. Funcionalidades do PRD e lotes do condutor (fase 7)

| Tela/função | SCAMPER | Decisão | Onde ficou | Fase/versão |
|---|---|---|---|---|
| Agrupamento do Kanban pelo passo do mapa | Substituir | O card do Kanban é uma funcionalidade do PRD (um `###` da seção Funcionalidades), ligada ao card pelo campo `feature`. Board sem funcionalidades no PRD segue agrupando pelo mapa | Software | próxima versão |
| Item que não cabe em nenhuma funcionalidade | Adaptar | Fica no grupo visível «Outros (fora do PRD)»; com 3 ou mais parecidos, um agente propõe uma funcionalidade nova ao PRD e o dono aprova | Software, Inbox | próxima versão |
| Reancorar os cards existentes | Adaptar | A âncora (Sonnet, até 30 cards por vez, uma por board, no ritmo do board) liga o que está claro e faz UMA pergunta agrupada sobre o resto | Inbox | próxima versão |
| Clique no título do card do Kanban | Modificar | Abre a página da funcionalidade: a descrição do PRD, «Agora», «Precisa de você», «Próximo», «Feito» recolhido com a prova de cada entrega e «Pedir item novo». A linha do item abre o item | Software | próxima versão |
| Linha do item no card | Modificar | Prefixo pelo estado: «Agora:», «Próximo:», «Precisa de você:»; um lote aparece como «Agora: N correções» | Software | próxima versão |
| Reordenar itens ou editar o PRD na página da funcionalidade | Eliminar | Não entram: a ordem é a da coluna e o PRD muda pela página do Produto | Removido | próxima versão |
| Condutor por item | Modificar | História nova sempre sozinha; correções e manutenções da mesma funcionalidade podem ir num lote, e o condutor escolhe quais | Software | próxima versão |
| Item que falha no lote | Adaptar | Sai do lote com o motivo e volta à fila sozinho; os outros publicam | Software, Inbox | próxima versão |
| Paradas do lote em Mínima | Combinar | Uma parada para o plano e uma para a entrega, cada uma listando todos os itens com a prova; aprovar vale para o lote | Inbox | próxima versão |
| Teto de gasto do lote | Adaptar | US$ 10 por item, no máximo US$ 30 (o teto de uma história) | Software | próxima versão |
| Dois condutores na mesma funcionalidade | Eliminar | Nunca ao mesmo tempo; o segundo espera com o motivo à vista | Software | próxima versão |
| Sessão de um lote que morre | Adaptar | Todos os itens seguem com o condutor marcado esperando o operador, como o card líder; o aviso nomeia cada item | Inbox | próxima versão |
