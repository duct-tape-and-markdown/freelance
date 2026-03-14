# freelance bash completion
_freelance_completions() {
  local cur prev commands
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="init validate visualize mcp daemon traversals completion"

  case "${COMP_WORDS[1]}" in
    daemon)
      COMPREPLY=( $(compgen -W "start stop status" -- "$cur") )
      return 0
      ;;
    traversals)
      COMPREPLY=( $(compgen -W "list inspect reset" -- "$cur") )
      return 0
      ;;
    init)
      COMPREPLY=( $(compgen -W "--scope --client --graphs --starter --daemon --yes --dry-run --json" -- "$cur") )
      return 0
      ;;
    validate|visualize)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
  esac

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands --help --version --json --quiet --verbose" -- "$cur") )
  fi
}
complete -F _freelance_completions freelance
