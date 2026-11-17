#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Backup', 'Restore')][string]$Operation,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9_-]*$')][string]$Project,
    [Parameter(Mandatory)][string]$EnvFile,
    [Parameter(Mandatory)][string]$Directory,
    [string]$ComposeOverride
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$composeFile = Join-Path $PSScriptRoot '../../compose.yaml'
$compose = @('compose', '-f', $composeFile)
if ($ComposeOverride) {
    $compose += @('-f', (Resolve-Path -LiteralPath $ComposeOverride).Path)
}
$compose += @('--env-file', (Resolve-Path -LiteralPath $EnvFile).Path, '-p', $Project, '--profile', 'planner')
$projectFilter = "label=com.docker.compose.project=$Project"
$databaseFile = 'database.pgdump'
# The worker spool is only needed for queued or running tasks, which backup checks below.
$volumeNames = @('uploads', 'models', 'agent-checkpoints')
$allVolumeNames = @('database', 'analysis-worker') + $volumeNames
$config = docker @compose config --format json | ConvertFrom-Json -AsHashtable
$configuredVolumes = @{}
foreach ($name in $allVolumeNames) {
    $volume = $config.volumes[$name].name
    if (!$volume -or $volume -in $configuredVolumes.Values) { throw "Expected a separate named volume for $name." }
    $configuredVolumes[$name] = $volume
}
$archiveNames = @($databaseFile) + @($volumeNames | ForEach-Object { "$_.tar" })
$tempDump = '/tmp/geocsv-' + [Guid]::NewGuid().ToString('N') + '.pgdump'

function Get-DatabaseContainer {
    $containers = @(docker @compose ps -q db)
    if ($containers.Count -ne 1) { throw 'Expected one running Compose database.' }
    return $containers[0]
}

function Get-VolumeName([string]$Name) {
    docker volume inspect -f '{{.Name}}' $configuredVolumes[$Name]
}

function Get-DatabaseVersions {
    $sql = "SELECT json_build_object('postgres', current_setting('server_version_num')::int / 10000, 'postgis', extversion) FROM pg_extension WHERE extname='postgis'"
    docker exec $db psql -qXAt -v ON_ERROR_STOP=1 -U geocsv -d geocsv -c $sql | ConvertFrom-Json
}

if ($Operation -eq 'Backup') {
    if (Test-Path -LiteralPath $Directory) { throw 'Choose a new backup directory.' }
    $db = Get-DatabaseContainer
    $running = @(docker ps -q --filter $projectFilter)
    if ($running.Count -ne 1 -or !$db.StartsWith($running[0])) {
        throw 'Stop the Compose web, agent, server and python services before backup.'
    }
    $active = docker exec $db psql -qXAt -v ON_ERROR_STOP=1 -U geocsv -d geocsv `
        -c "SELECT count(*) FROM geocsv_analysis_runs WHERE status IN ('queued','running')"
    if ($active -ne '0') { throw 'Finish queued and running analyses before backup.' }

    $volumes = @($volumeNames | ForEach-Object { Get-VolumeName $_ })
    $versions = Get-DatabaseVersions
    $dbImage = docker inspect -f '{{.Image}}' $db
    $backupPath = (New-Item -ItemType Directory -Path $Directory).FullName
    docker exec $db pg_dump -U geocsv -d geocsv --format=custom -f $tempDump
    try {
        docker cp "${db}:$tempDump" (Join-Path $backupPath $databaseFile)
    } finally {
        docker exec $db rm -- $tempDump
    }
    for ($index = 0; $index -lt $volumeNames.Count; $index++) {
        docker run --rm --network none --entrypoint tar `
            --mount "type=volume,source=$($volumes[$index]),target=/data,readonly" `
            --mount "type=bind,source=$backupPath,target=/backup" `
            $dbImage -cpf "/backup/$($volumeNames[$index]).tar" -C /data .
    }
    $hashes = [ordered]@{}
    foreach ($name in $archiveNames) {
        $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $backupPath $name)).Hash
    }
    [ordered]@{ format = 1; sourceProject = $Project; createdUtc = [DateTime]::UtcNow.ToString('o');
        postgres = $versions.postgres; postgis = $versions.postgis; sha256 = $hashes } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupPath 'manifest.json') -Encoding utf8
    Write-Output "Backup complete at $backupPath"
    return
}

$backupPath = (Resolve-Path -LiteralPath $Directory).Path
$manifest = Get-Content -LiteralPath (Join-Path $backupPath 'manifest.json') -Raw | ConvertFrom-Json -AsHashtable
if ($manifest.format -ne 1) { throw 'Unsupported GeoCSV backup format.' }
foreach ($name in $archiveNames) {
    if ((Get-FileHash -LiteralPath (Join-Path $backupPath $name)).Hash -ne $manifest.sha256[$name]) {
        throw "Backup checksum differs for $name."
    }
}
if (@(docker ps -aq --filter $projectFilter).Count) {
    throw 'Remove the target Compose containers before restoring into fresh volumes.'
}
$existingVolumes = @(docker volume ls -q)
foreach ($volume in $configuredVolumes.Values) {
    if ($volume -in $existingVolumes) { throw "Target volume $volume already exists." }
}

docker @compose create --no-build --pull never
docker @compose up --no-build --pull never -d --wait db
$db = Get-DatabaseContainer
$versions = Get-DatabaseVersions
if ($manifest.postgres -ne $versions.postgres -or $manifest.postgis -ne $versions.postgis) {
    throw 'Use the backup PostgreSQL major and PostGIS extension versions for this restore.'
}
$dbImage = docker inspect -f '{{.Image}}' $db
docker cp (Join-Path $backupPath $databaseFile) "${db}:$tempDump"
try {
    # The target was created above. Replace the entrypoint's bootstrap schema with the dump.
    docker exec $db dropdb -U geocsv geocsv
    docker exec $db createdb -U geocsv -T template0 geocsv
    docker exec $db pg_restore -U geocsv -d geocsv --exit-on-error --single-transaction $tempDump
} finally {
    docker exec $db rm -- $tempDump
}
foreach ($name in $volumeNames) {
    $volume = Get-VolumeName $name
    docker run --rm --network none --entrypoint tar `
        --mount "type=volume,source=$volume,target=/data" `
        --mount "type=bind,source=$backupPath,target=/backup,readonly" `
        $dbImage -xpf "/backup/$name.tar" -C /data
}
Write-Output "Restore complete in $Project. Start the application services after checking the target."
