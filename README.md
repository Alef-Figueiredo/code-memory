# Code Memory Visualizer

Etapa 2 do projeto: uma extensao do VS Code para executar codigo Python passo a passo, mostrar a linha atual e visualizar variaveis conforme o estado da execucao muda.

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
- Visualizacao de variaveis criadas e alteradas a cada passo.
- Historico visual dos estados ja capturados, permitindo voltar e avancar por passos anteriores.
- Adaptador `PythonAdapter`, deixando a interface separada da execucao da linguagem.

Nesta etapa ainda nao ha visualizacao detalhada de stack, heap, objetos ou referencias. O campo `heap` existe no modelo, mas fica vazio ate a Etapa 3.

## Como testar no VS Code

1. Abra esta pasta no VS Code.
2. Pressione `F5` para iniciar uma janela de desenvolvimento da extensao.
3. Na nova janela, abra `examples/sample.py` ou outro arquivo Python.
4. Execute o comando `Code Memory: Start` pela paleta de comandos.
5. Use `Executar`, `Proxima etapa`, `Voltar etapa` e `Reiniciar` no painel.
6. Observe a coluna `Variaveis` para ver valores criados e alterados.

## Teste de fumaca

O projeto tem um teste simples do runner Python:

```bash
npm test
```

Ele executa `examples/sample.py` por meio de `src/python/traceRunner.py` e verifica se eventos de pausa, estado de variaveis e termino sao emitidos.

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

## Arquitetura inicial

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
```

A webview guarda os snapshots ja visitados para permitir navegacao visual para tras e para frente. Quando esta no ultimo snapshot pausado, `Proxima etapa` continua a execucao Python real.

## Proxima etapa

A Etapa 3 deve expandir a representacao de memoria com stack frames detalhados, heap, objetos, referencias compartilhadas e pequenas transicoes visuais.
