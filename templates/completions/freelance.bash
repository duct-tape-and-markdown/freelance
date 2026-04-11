# freelance bash completion
_freelance_completions() {
  local cur prev commands
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="init validate visualize mcp daemon status start advance context inspect reset memory config guide distill sources memory-register completion"

  case "${COMP_WORDS[1]}" in
    daemon)
      COMPREPLY=( $(compgen -W "start stop status" -- "$cur") )
      return 0
      ;;
    memory)
      COMPREPLY=( $(compgen -W "status browse inspect search related by-source register emit end" -- "$cur") )
      return 0
      ;;
    context)
      COMPREPLY=( $(compgen -W "set" -- "$cur") )
      return 0
      ;;
    sources)
      COMPREPLY=( $(compgen -W "hash check validate" -- "$cur") )
      return 0
      ;;
    config)
      COMPREPLY=( $(compgen -W "show set-local" -- "$cur") )
      return 0
      ;;
    init)
      COMPREPLY=( $(compgen -W "--scope --client --workflows --starter --hooks --yes --dry-run --json" -- "$cur") )
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
