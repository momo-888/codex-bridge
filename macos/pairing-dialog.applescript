on run argv
  set deviceName to item 1 of argv
  set remoteAddress to item 2 of argv
  set promptText to "设备：" & deviceName & return & "来源 IP：" & remoteAddress & return & return & "是否允许此设备控制这台 Mac 上的 Codex？" & return & "请只允许你认识的设备。"
  try
    set dialogResult to display dialog promptText with title "Codex Bridge 连接请求" buttons {"拒绝", "允许"} default button "拒绝" cancel button "拒绝" with icon caution
    return button returned of dialogResult
  on error number -128
    return "拒绝"
  end try
end run
