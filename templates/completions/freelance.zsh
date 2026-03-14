#compdef freelance
_freelance() {
  local -a commands
  commands=(
    'init:Set up Freelance for a project or user'
    'validate:Validate graph definitions'
    'visualize:Export graph as Mermaid or DOT diagram'
    'mcp:Start MCP server'
    'daemon:Manage the Freelance daemon'
    'traversals:Manage active traversals'
    'completion:Output shell completion script'
  )

  _arguments -C \
    '--json[Output as JSON]' \
    '--no-color[Disable colors]' \
    '--verbose[Verbose output]' \
    '(-q --quiet)'{-q,--quiet}'[Quiet mode]' \
    '1:command:->cmds' \
    '*::arg:->args'

  case "$state" in
    cmds)
      _describe -t commands 'freelance command' commands
      ;;
    args)
      case $words[1] in
        daemon)
          local -a subcmds
          subcmds=('start:Start the daemon' 'stop:Stop the daemon' 'status:Check status')
          _describe -t commands 'daemon command' subcmds
          ;;
        traversals)
          local -a subcmds
          subcmds=('list:List traversals' 'inspect:Inspect a traversal' 'reset:Reset a traversal')
          _describe -t commands 'traversals command' subcmds
          ;;
        validate)
          _files -/
          ;;
        visualize)
          _files -g '*.graph.yaml'
          ;;
      esac
      ;;
  esac
}
_freelance
