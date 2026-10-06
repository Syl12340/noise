"""Read-only local process evidence; do not print command lines or credentials."""
import ctypes
from ctypes import wintypes
import json
import os

class Entry(ctypes.Structure):
    _fields_=[('dwSize',wintypes.DWORD),('cntUsage',wintypes.DWORD),
              ('pid',wintypes.DWORD),('heap',ctypes.c_void_p),('module',wintypes.DWORD),
              ('threads',wintypes.DWORD),('parent',wintypes.DWORD),
              ('priority',wintypes.LONG),('flags',wintypes.DWORD),('name',wintypes.WCHAR*260)]
class UnicodeString(ctypes.Structure):
    _fields_=[('length',wintypes.USHORT),('maximum',wintypes.USHORT),('buffer',ctypes.c_void_p)]

k=ctypes.WinDLL('kernel32',use_last_error=True)
n=ctypes.WinDLL('ntdll')
k.CreateToolhelp32Snapshot.restype=wintypes.HANDLE
k.OpenProcess.restype=wintypes.HANDLE
k.CloseHandle.argtypes=[wintypes.HANDLE]
k.Process32FirstW.argtypes=[wintypes.HANDLE,ctypes.POINTER(Entry)]
k.Process32NextW.argtypes=[wintypes.HANDLE,ctypes.POINTER(Entry)]
n.NtQueryInformationProcess.argtypes=[wintypes.HANDLE,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong)]
n.NtQueryInformationProcess.restype=ctypes.c_long
snapshot=k.CreateToolhelp32Snapshot(2,0)
entry=Entry();entry.dwSize=ctypes.sizeof(entry)
evidence=[];unreadable=0
try:
    more=k.Process32FirstW(snapshot,ctypes.byref(entry))
    while more:
        if entry.pid!=os.getpid() and (entry.name.lower() in ['node.exe','dsh.exe','codex.exe','python.exe','pythonw.exe'] or 'dsh' in entry.name.lower()):
            process=k.OpenProcess(0x1000,False,entry.pid)
            if process:
                try:
                    length=ctypes.c_ulong()
                    n.NtQueryInformationProcess(process,60,None,0,ctypes.byref(length))
                    if 0<length.value<1048576:
                        buffer=ctypes.create_string_buffer(length.value)
                        status=n.NtQueryInformationProcess(process,60,buffer,length.value,ctypes.byref(length))
                        if status==0:
                            value=UnicodeString.from_buffer(buffer)
                            command=ctypes.wstring_at(value.buffer,value.length//2) if value.buffer else ''
                            low=command.lower()
                            if 'dsh' in low:
                                evidence.append({'pid':entry.pid,'parentPid':entry.parent,'image':entry.name,
                                  'mentionsRsCore':'rs-core' in low,
                                  'mentionsAssignedDocument':'current_signal_state_machine' in low or 'numeric_semantics' in low,
                                  'looksLikeCliTask':entry.name.lower() in ['node.exe','codex.exe','dsh.exe']})
                        else: unreadable+=1
                finally:k.CloseHandle(process)
            else:unreadable+=1
        more=k.Process32NextW(snapshot,ctypes.byref(entry))
finally:k.CloseHandle(snapshot)
print(json.dumps({'readOnlyDshProcessEvidence':evidence,'unreadableCandidateProcesses':unreadable,
                  'note':'No command text exposed. A bridge/server process alone does not prove an editing worker is running.'}))
