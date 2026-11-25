#!/bin/zsh
# Checks the helpers of lib.sh without a browser: a script must fail when a check fails, when a
# check prints broken or non-object JSON, and when there is no check at all.
# Usage: zsh test/browser/lib-selftest.sh     Exits 1 if a helper lets a failure through.
LIB="${0:A:h}/lib.sh"
probe() { zsh -c "source ${(q)LIB}; $1; report probe" >/dev/null 2>&1; print -r -- $?; }
failed=0
expect() { # expect <name> <wanted exit> <body>
  local got
  got=$(probe "$3")
  [[ $got == "$2" ]] || { print -r -- "FAIL $1: exit $got, wanted $2"; failed=1; }
}
expect "all pass" 0 'check a "{\"pass\":true}"'
expect "one fails" 1 'check a "{\"pass\":true}"; check b "{\"pass\":false}"'
expect "broken JSON fails" 1 'check a "{\"pass\":true}"; check b "not json"'
expect "an array fails" 1 'check a "{\"pass\":true}"; check b "[1]"'
expect "a string fails" 1 'check a "{\"pass\":true}"; check b "\"ok\""'
expect "two objects fail" 1 'check a "{\"pass\":true}"; check b "{\"pass\":true} {\"pass\":true}"'
expect "empty output fails" 1 'check a "{\"pass\":true}"; check b ""'
expect "no check fails" 1 ':'
(( failed )) || print -r -- "lib-selftest: all passed"
exit $failed
