# Code Memory Visualizer

Etapa 3 do projeto: uma extensao do VS Code para executar codigo Python passo a passo e visualizar estado de execucao, variaveis, stack, heap, objetos e referencias.

## O que esta etapa entrega

- Comando `Code Memory: Start`.
- Painel webview dentro do VS Code.
- Leitura do arquivo Python ativo ou selecao de um arquivo `.py`.
- Execucao Python com pausa na proxima linha rastreada.
- Controles basicos:
  - Executar
  - Voltar etapa
  - Proxima etapa
  - Reiniciar
- Destaque visual da linha atualmente executada.
- Modelo comum `ExecutionState`, com:
  - `currentLine`
  - `variables`
  - `callStack`
  - `heap`
  - `stackFrames`
  - `heapObjects`
  - `references`
- Visualizacao de variaveis criadas e alteradas a cada passo.
- Visualizacao de stack frames, parametros e variaveis locais.
- Visualizacao de heap objects para listas, tuplas, dicionarios, conjuntos e objetos com `__dict__`.
- Visualizacao de referencias de variaveis para objetos e de campos/itens de objetos para outros objetos.
- Indicacao visual quando variaveis, objetos, frames e referencias aparecem ou mudam.
- Historico visual dos estados ja capturados, permitindo voltar e avancar por passos anteriores.
- Adaptador `PythonAdapter`, mantendo a interface separada da execucao da linguagem.

Nesta etapa ainda nao ha suporte a Java. Isso fica para a Etapa 4.

## Como testar no VS Code

1. Abra esta pasta no VS Code.
2. Pressione `F5` para iniciar uma janela de desenvolvimento da extensao.
3. Na nova janela, abra `examples/sample.py` ou outro arquivo Python.
4. Execute o comando `Code Memory: Start` pela paleta de comandos.
5. Use `Executar`, `Proxima etapa`, `Voltar etapa` e `Reiniciar` no painel.
6. Observe as secoes `Stack`, `Heap`, `Referencias`, `Variaveis` e `Saida`.

## Teste de fumaca

O projeto tem um teste simples do runner Python:

```bash
npm test
```

Ele executa `examples/sample.py` por meio de `src/python/traceRunner.py` e verifica se eventos de pausa, stack frames, heap objects, referencias e termino sao emitidos.

Se o `npm` local nao estiver disponivel, rode o script diretamente:

```bash
node scripts/smoke-test.js
```

Se o Python nao estiver no `PATH`, informe o executavel:

```bash
CODE_MEMORY_PYTHON=/path/to/python npm test
```

No PowerShell:

```powershell
$env:CODE_MEMORY_PYTHON="C:\path\to\python.exe"; npm test
```

## Configuracao

A extensao usa `python` por padrao. Se necessario, ajuste `codeMemory.pythonPath` nas configuracoes do VS Code.

Exemplos:

```json
{
  "codeMemory.pythonPath": "python"
}
```

```json
{
  "codeMemory.pythonPath": "py -3"
}
```

## Arquitetura

```text
VS Code command
  -> MemoryVisualizerPanel
  -> LanguageAdapter
  -> PythonAdapter
  -> traceRunner.py
```

A camada visual recebe eventos comuns, como `paused`, `output`, `done` e `error`. O adaptador Python transforma a execucao real do Python nesses eventos.

O evento `paused` carrega um snapshot neste formato:

```text
ExecutionState
  currentLine
  variables
  callStack
  heap
  stackFrames
  heapObjects
  references
```

A webview guarda os snapshots ja visitados para permitir navegacao visual para tras e para frente. Quando esta no ultimo snapshot pausado, `Proxima etapa` continua a execucao Python real.

## Limitacoes atuais

- A visualizacao de heap e didatica, nao uma representacao byte a byte da memoria real do CPython.
- Valores muito grandes sao resumidos para manter o painel legivel.
- Objetos nativos sem `__dict__` aparecem no heap com `repr`, mas sem campos internos detalhados.
- Voltar etapa navega pelo historico visual ja capturado; ele nao desfaz a execucao Python real.

## Proxima etapa

A Etapa 4 deve adicionar suporte a Java com uma arquitetura baseada em adaptadores/providers, mantendo o visualizador independente da linguagem.