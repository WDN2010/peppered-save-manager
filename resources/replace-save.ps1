param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$TemporaryPath,
  [Parameter(Mandatory = $true)][string]$ExpectedTargetSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedReplacementSha256
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class PepperedGuardedReplace
{
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint LOCKFILE_FAIL_IMMEDIATELY = 0x00000001;
    private const uint LOCKFILE_EXCLUSIVE_LOCK = 0x00000002;
    private const uint REPLACEFILE_IGNORE_MERGE_ERRORS = 0x00000002;
    private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;

    [StructLayout(LayoutKind.Sequential)]
    private struct OVERLAPPED
    {
        public IntPtr Internal;
        public IntPtr InternalHigh;
        public uint Offset;
        public uint OffsetHigh;
        public IntPtr EventHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool LockFileEx(
        SafeFileHandle fileHandle,
        uint flags,
        uint reserved,
        uint bytesLow,
        uint bytesHigh,
        ref OVERLAPPED overlapped);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ReplaceFileW(
        string replacedFileName,
        string replacementFileName,
        string backupFileName,
        uint replaceFlags,
        IntPtr exclude,
        IntPtr reserved);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string existingFileName, string newFileName, uint flags);

    private static SafeFileHandle OpenParent(string parent)
    {
        SafeFileHandle handle = CreateFileW(
            parent,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int code = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(code, "PARENT_LOCK_FAILED_WIN32_" + code);
        }
        return handle;
    }

    private static FileStream OpenLockedRead(string fileName)
    {
        FileStream stream = new FileStream(
            fileName,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read | FileShare.Delete,
            4096,
            FileOptions.SequentialScan);
        OVERLAPPED overlapped = new OVERLAPPED();
        if (!LockFileEx(
            stream.SafeFileHandle,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            UInt32.MaxValue,
            UInt32.MaxValue,
            ref overlapped))
        {
            int code = Marshal.GetLastWin32Error();
            stream.Dispose();
            throw new Win32Exception(code, "FILE_LOCK_FAILED_WIN32_" + code);
        }
        return stream;
    }

    private static string Hash(FileStream stream)
    {
        stream.Position = 0;
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(stream);
            return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
        }
    }

    private static void RequireHash(FileStream stream, string expected, string marker)
    {
        string actual = Hash(stream);
        if (!String.Equals(actual, expected, StringComparison.Ordinal))
            throw new InvalidOperationException(marker + ": expected " + expected + ", got " + actual);
    }

    public static void Execute(
        string targetPath,
        string temporaryPath,
        string expectedTargetSha256,
        string expectedReplacementSha256)
    {
        string target = Path.GetFullPath(targetPath);
        string temporary = Path.GetFullPath(temporaryPath);
        string targetParent = Path.GetDirectoryName(target).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string temporaryParent = Path.GetDirectoryName(temporary).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!String.Equals(targetParent, temporaryParent, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("CROSS_DIRECTORY_REPLACE_REJECTED");

        using (SafeFileHandle parentHandle = OpenParent(targetParent))
        {
            using (FileStream replacement = OpenLockedRead(temporary))
            {
                RequireHash(replacement, expectedReplacementSha256, "REPLACEMENT_CHANGED");

                if (String.Equals(expectedTargetSha256, "ABSENT", StringComparison.Ordinal))
                {
                    if (File.Exists(target))
                        throw new InvalidOperationException("TARGET_APPEARED");
                    if (!MoveFileExW(temporary, target, MOVEFILE_WRITE_THROUGH))
                    {
                        int code = Marshal.GetLastWin32Error();
                        throw new Win32Exception(code, "MOVE_FAILED_WIN32_" + code);
                    }
                    return;
                }

                using (FileStream current = OpenLockedRead(target))
                {
                    RequireHash(current, expectedTargetSha256, "TARGET_CHANGED");
                    if (!ReplaceFileW(target, temporary, null, REPLACEFILE_IGNORE_MERGE_ERRORS, IntPtr.Zero, IntPtr.Zero))
                    {
                        int code = Marshal.GetLastWin32Error();
                        throw new Win32Exception(code, "REPLACE_FAILED_WIN32_" + code);
                    }
                }
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  [PepperedGuardedReplace]::Execute(
    $TargetPath,
    $TemporaryPath,
    $ExpectedTargetSha256,
    $ExpectedReplacementSha256
  )
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
